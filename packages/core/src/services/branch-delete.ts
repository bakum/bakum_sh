import { eq } from 'drizzle-orm';
import { BmError } from '@bm/shared';
import type { Ctx } from '../context';
import { branches, builds, type JobRow } from '../db/schema';
import * as git from '../git';
import { resolveBranchScope } from '../config/effective';
import { assertFolderOnBranch, folderBlock, removeWorktree } from '../git/worktrees';
import { dropBuildResources } from '../builds/drop';
import { getQueue, type JobContext } from '../jobs/queue';
import { mustBranch, invalidateGitCache } from './branches';
import { localWatcher } from './watch-local';
import { audit } from './audit';
import { setAutoAddSkip } from './branch-rows';
import { bus } from '../events';
import { notify } from './notify';
import { isGoneFromRemote, keepReasonOf, keepReasonText } from './remote-gone';
import { t } from '../i18n';

export async function deletePreview(ctx: Ctx, branchId: number) {
  const b = mustBranch(ctx, branchId);
  const cfg = ctx.store.require(b.projectId);
  const scope = resolveBranchScope(cfg, b.name, b.stage, b.overrides).scope;
  let dirty: string | null = null;
  if (b.worktreePath) dirty = (await git.worktreeChanges(b.worktreePath).catch(() => [])).join('\n') || null;
  const n = ctx.db.select().from(builds).where(eq(builds.branchId, b.id)).all().filter((x) => x.status !== 'dropped').length;
  return {
    dirty,
    builds: n,
    canDeleteRemote: false,
    protected: b.stage === 'production' || scope.protected,
    // Deleting drops the builds, and a build is not dropped while another branch is open in its folder (D59).
    folderBlocked: n ? await folderBlock(b, scope) : null,
  };
}

/** Validates the Delete request (spec 8.10) and queues the job. */
export async function requestDelete(ctx: Ctx, p: { branchId: number; confirmSlug: string; deleteRemote: boolean; forceDirty: boolean }) {
  const b = mustBranch(ctx, p.branchId);
  if (p.confirmSlug !== b.slug) throw new BmError('CONFIRM', t('branchDelete.confirm', { slug: b.slug }));
  if (p.deleteRemote) throw new BmError('POSTPONED', t('branchDelete.remotePostponed'));
  const pv = await deletePreview(ctx, p.branchId);
  if (pv.protected) throw new BmError('PROTECTED', t('branchDelete.protected'));
  if (pv.folderBlocked) throw new BmError('FOLDER_WRONG_BRANCH', pv.folderBlocked);
  if (pv.dirty && !p.forceDirty) throw new BmError('WORKTREE_DIRTY', t('branchDelete.dirty', { dirty: pv.dirty }));
  return { jobId: getQueue().enqueue('delete_branch', { projectId: b.projectId, branchId: b.id }, { branch: b.name, ...p }) };
}

export async function deleteBranchExecutor(ctx: Ctx, job: JobRow, jc: JobContext): Promise<void> {
  const b = mustBranch(ctx, job.branchId!);
  const cfg = ctx.store.require(b.projectId);
  const params = job.params as { forceDirty?: boolean; remoteGone?: boolean };
  if (params.remoteGone) {
    // Queued by a fetch (D50), possibly behind a build: check again that nothing is lost without the user.
    if (!(await isGoneFromRemote(cfg, b))) {
      jc.log(`${b.name} is back in ${cfg.repo.remote}: not deleted`);
      return;
    }
    const reason = await keepReasonOf(cfg, b);
    if (reason) {
      jc.log(`${b.name}: not deleted — ${keepReasonText(reason)}`);
      return;
    }
  }
  const all = ctx.db.select().from(builds).where(eq(builds.branchId, b.id)).all();
  if (all.some((x) => x.status !== 'dropped')) await assertFolderOnBranch(b, resolveBranchScope(cfg, b.name, b.stage, b.overrides).scope, { usable: false });
  // Newest first: the live container is taken down with its own build.
  for (const x of all.sort((a, c) => c.number - a.number)) {
    if (x.status === 'dropped') continue;
    jc.log(`drop build #${x.number}`);
    await dropBuildResources(ctx, cfg, x, jc.log);
    ctx.db.update(builds).set({ status: 'dropped', live: false, droppedAt: new Date().toISOString() }).where(eq(builds.id, x.id)).run();
  }
  if (b.worktreePath) {
    jc.log(`git worktree remove ${b.worktreePath}`);
    // remoteGone: keepReasonOf above found no user changes; only Python bytecode may be left there.
    // Only Odoo's bytecode left (no user changes): `git worktree remove` still needs --force for untracked files.
    const onlyBytecode = !!b.worktreePath && !(await git.worktreeChanges(b.worktreePath).catch(() => ['?'])).length;
    await removeWorktree(ctx, cfg, b, !!params.forceDirty || !!params.remoteGone || onlyBytecode);
  }
  ctx.db.delete(builds).where(eq(builds.branchId, b.id)).run();
  ctx.db.delete(branches).where(eq(branches.id, b.id)).run();
  // A branch deleted by the user stays out of auto-add; one deleted on GitHub may come back under the same name.
  if (!params.remoteGone) setAutoAddSkip(ctx, cfg.id, b.name, true);
  invalidateGitCache(cfg.id);
  await localWatcher()?.sync();
  audit(ctx, {
    projectId: cfg.id,
    action: 'branch.delete',
    target: b.name,
    params: {
      ...(params.remoteGone ? { reason: 'remote-gone' } : {}),
      builds: all.map((x) => ({ n: x.number, db: x.dbName, status: x.status, sha: x.commitSha })),
    },
  });
  if (params.remoteGone) {
    const n = all.filter((x) => x.status !== 'dropped').length;
    notify(ctx, 'branchRemoved', t('branchDelete.removedTitle', { branch: b.name }), t('branchDelete.removedBody', { n }), { route: `/projects/${cfg.id}` });
  }
  bus.emit({ type: 'branch.changed', projectId: cfg.id, branchId: b.id });
}
