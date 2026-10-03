import type { ProjectConfig, ResolvedBranchScope, Stage } from '@bm/shared';
import type { Ctx } from '../context';
import type { BranchRow } from '../db/schema';
import * as git from '../git';
import { resolveBranchScope } from '../config/effective';
import { repoDir } from '../git/worktrees';
import { getQueue, type JobContext } from '../jobs/queue';
import { branchRows } from './branch-rows';
import { notify } from './notify';
import { t } from '../i18n';

/** Why a branch deleted on the remote stays in the app (D50). */
export type KeepReason = 'production' | 'protected' | 'folder' | 'setting' | 'dirty';

export const keepReasonText = (reason: KeepReason): string => t(`remoteGone.${reason}`);

/** A branch gone from the remote: null — delete it with its builds, otherwise the reason to keep it (D50). */
export function remoteGoneDecision(i: {
  stage: Stage;
  scope: Pick<ResolvedBranchScope, 'protected' | 'folder' | 'deleteWithRemote'>;
  protectedBranch: boolean;
  dirty: boolean;
}): KeepReason | null {
  if (i.stage === 'production') return 'production';
  if (i.scope.protected || i.protectedBranch) return 'protected';
  if (i.scope.folder) return 'folder';
  if (!i.scope.deleteWithRemote) return 'setting';
  if (i.dirty) return 'dirty';
  return null;
}

/** The branch was seen on the remote and is not there now (the mirror is fetched with --prune, D49). */
export async function isGoneFromRemote(cfg: ProjectConfig, b: BranchRow): Promise<boolean> {
  return !!b.lastSeenRemoteSha && !(await git.remoteSha(repoDir(cfg), cfg.repo.remote, b.name));
}

export async function keepReasonOf(cfg: ProjectConfig, b: BranchRow): Promise<KeepReason | null> {
  const scope = resolveBranchScope(cfg, b.name, b.stage, b.overrides).scope;
  const dirty = b.worktreePath ? (await git.worktreeChanges(b.worktreePath).catch(() => [])).length > 0 : false;
  return remoteGoneDecision({ stage: b.stage, scope, protectedBranch: cfg.repo.protectedBranches.includes(b.name), dirty });
}

/**
 * After a successful fetch (D50): branches of the app deleted on the remote are deleted with their builds by the usual
 * `delete_branch` job. Kept branches are reported once per remote head they had.
 */
export async function pruneGoneBranches(ctx: Ctx, cfg: ProjectConfig, jc: JobContext): Promise<void> {
  const rows = branchRows(ctx, cfg.id);
  const gone: BranchRow[] = [];
  for (const b of rows) if (await isGoneFromRemote(cfg, b)) gone.push(b);
  if (!gone.length) return;
  // Safety net: a remote pointing to another repository (or emptied) looks like every branch deleted at once.
  const remoteBranches = (await git.listBranches(repoDir(cfg), cfg.repo.remote)).filter((g) => g.source !== 'local');
  if (!remoteBranches.length || gone.some((b) => b.stage === 'production')) {
    jc.log(`not deleting branches gone from ${cfg.repo.remote}: the production branch is gone too or the remote has no branches`);
    return;
  }
  for (const b of gone) {
    if (getQueue().activeForBranch(b.id)?.type === 'delete_branch') continue;
    const reason = await keepReasonOf(cfg, b);
    if (!reason) {
      jc.log(`${b.name}: deleted in ${cfg.repo.remote} → delete_branch`);
      getQueue().enqueue('delete_branch', { projectId: cfg.id, branchId: b.id }, { branch: b.name, remoteGone: true, forceDirty: false });
      continue;
    }
    jc.log(`${b.name}: deleted in ${cfg.repo.remote}, kept (${reason})`);
    const key = `remote-gone:${b.id}:${b.lastSeenRemoteSha}`;
    if (reason === 'setting' || ctx.sqlite.prepare('SELECT 1 FROM kv WHERE key = ?').get(key)) continue;
    ctx.sqlite.prepare('INSERT OR REPLACE INTO kv(key, value) VALUES (?, ?)').run(key, new Date().toISOString());
    notify(
      ctx,
      'branchRemoved',
      t('remoteGone.title', { branch: b.name }),
      t('remoteGone.body', { reason: keepReasonText(reason) }),
      { route: `/projects/${cfg.id}/branches/${b.id}` },
    );
  }
}
