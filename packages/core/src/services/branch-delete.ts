import { eq } from 'drizzle-orm';
import { BmError } from '@bm/shared';
import type { Ctx } from '../context';
import { branches, builds, type JobRow } from '../db/schema';
import * as git from '../git';
import { resolveBranchScope } from '../config/effective';
import { removeWorktree } from '../git/worktrees';
import { dropBuildResources } from '../builds/drop';
import { getQueue, type JobContext } from '../jobs/queue';
import { mustBranch, invalidateGitCache } from './branches';
import { localWatcher } from './watch-local';
import { audit } from './audit';
import { setAutoAddSkip } from './branch-rows';
import { bus } from '../events';

export async function deletePreview(ctx: Ctx, branchId: number) {
  const b = mustBranch(ctx, branchId);
  const cfg = ctx.store.require(b.projectId);
  const scope = resolveBranchScope(cfg, b.name, b.stage, b.overrides).scope;
  let dirty: string | null = null;
  if (b.worktreePath) dirty = (await git.statusPorcelain(b.worktreePath).catch(() => '')).trim() || null;
  const n = ctx.db.select().from(builds).where(eq(builds.branchId, b.id)).all().filter((x) => x.status !== 'dropped').length;
  return {
    dirty,
    builds: n,
    canDeleteRemote: false,
    protected: b.stage === 'production' || scope.protected,
  };
}

/** Validates the Delete request (spec 8.10) and queues the job. */
export async function requestDelete(ctx: Ctx, p: { branchId: number; confirmSlug: string; deleteRemote: boolean; forceDirty: boolean }) {
  const b = mustBranch(ctx, p.branchId);
  if (p.confirmSlug !== b.slug) throw new BmError('CONFIRM', `Для удаления введите slug ветки: ${b.slug}`);
  if (p.deleteRemote) throw new BmError('POSTPONED', 'Удаление ветки в origin отложено (docs/decisions.md D44): удалите её на GitHub.');
  const pv = await deletePreview(ctx, p.branchId);
  if (pv.protected) throw new BmError('PROTECTED', 'Ветка защищена: снимите защиту (protected) в Settings ветки. Production удалить нельзя.');
  if (pv.dirty && !p.forceDirty) throw new BmError('WORKTREE_DIRTY', `В worktree есть незакоммиченные изменения:\n${pv.dirty}\nПодтвердите их потерю отдельно.`);
  return { jobId: getQueue().enqueue('delete_branch', { projectId: b.projectId, branchId: b.id }, { branch: b.name, ...p }) };
}

export async function deleteBranchExecutor(ctx: Ctx, job: JobRow, jc: JobContext): Promise<void> {
  const b = mustBranch(ctx, job.branchId!);
  const cfg = ctx.store.require(b.projectId);
  const params = job.params as { forceDirty?: boolean };
  const all = ctx.db.select().from(builds).where(eq(builds.branchId, b.id)).all();
  // Newest first: the live container is taken down with its own build.
  for (const x of all.sort((a, c) => c.number - a.number)) {
    if (x.status === 'dropped') continue;
    jc.log(`drop build #${x.number}`);
    await dropBuildResources(ctx, cfg, x, jc.log);
    ctx.db.update(builds).set({ status: 'dropped', live: false, droppedAt: new Date().toISOString() }).where(eq(builds.id, x.id)).run();
  }
  if (b.worktreePath) {
    jc.log(`git worktree remove ${b.worktreePath}`);
    await removeWorktree(ctx, cfg, b, !!params.forceDirty);
  }
  ctx.db.delete(builds).where(eq(builds.branchId, b.id)).run();
  ctx.db.delete(branches).where(eq(branches.id, b.id)).run();
  setAutoAddSkip(ctx, cfg.id, b.name, true);
  invalidateGitCache(cfg.id);
  await localWatcher()?.sync();
  audit(ctx, {
    projectId: cfg.id,
    action: 'branch.delete',
    target: b.name,
    params: { builds: all.map((x) => ({ n: x.number, db: x.dbName, status: x.status, sha: x.commitSha })) },
  });
  bus.emit({ type: 'branch.changed', projectId: cfg.id, branchId: b.id });
}
