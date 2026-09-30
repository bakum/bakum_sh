import { eq } from 'drizzle-orm';
import type { ProjectConfig } from '@bm/shared';
import type { Ctx } from '../context';
import { branches, type BranchRow } from '../db/schema';
import { resolveBranchScope } from '../config/effective';
import * as git from '../git';
import { DETACHED, folderBranchMismatch } from '../git/worktrees';
import { liveBuild } from './view';
import { requestBuild } from './request';
import { bus } from '../events';
import { audit } from '../services/audit';
import { log } from '../util/logger';

function pause(ctx: Ctx, b: BranchRow, reason: 'dirty-worktree' | 'force-push'): void {
  ctx.db.update(branches).set({ pausedReason: reason }).where(eq(branches.id, b.id)).run();
  audit(ctx, { projectId: b.projectId, action: 'branch.paused', target: b.name, params: { reason } });
  bus.emit({ type: 'branch.changed', projectId: b.projectId, branchId: b.id });
}

/**
 * A new commit arrived for a branch (spec 8.3): `origin/<b>` moved after fetch (code from the mirror) or
 * HEAD of the user's folder moved (code from the folder, D33). Acts according to onNewCommit / onForcePush.
 * Branches without a live build only get the «unbuilt commits» / «no build» badge.
 */
export async function onNewCommit(ctx: Ctx, cfg: ProjectConfig, b: BranchRow, sha: string, opts: { forcePush: boolean }): Promise<void> {
  if (!cfg.enabled) return;
  const scope = resolveBranchScope(cfg, b.name, b.stage, b.overrides).scope;
  const live = liveBuild(ctx, b.id);
  if (!live || live.commitSha === sha) return;
  if (b.pausedReason) return;
  // Code from the folder while another branch is open there: nothing happens to the build (D59).
  if (scope.folder && (await folderBranchMismatch(scope.folder, b.name).catch(() => DETACHED))) return;
  if (opts.forcePush) {
    if (scope.onForcePush === 'pause') {
      pause(ctx, b, 'force-push');
      return;
    }
  }
  if (!scope.folder && b.worktreePath) {
    const dirty = await git.worktreeChanges(b.worktreePath).catch(() => []);
    if (dirty.length) {
      pause(ctx, b, 'dirty-worktree');
      return;
    }
  }
  const kind = opts.forcePush ? 'new' : scope.onNewCommit;
  if (kind === 'none') {
    bus.emit({ type: 'branch.changed', projectId: b.projectId, branchId: b.id });
    return;
  }
  try {
    requestBuild(ctx, b.id, { trigger: 'new_commit', kind, targetSha: sha });
  } catch (err) {
    // Another build is active: the commit stays visible as «unbuilt commits».
    log().info({ branch: b.name, err: (err as Error).message }, 'new commit not built now');
  }
}

/** Clears a pause (after the user resolved dirty worktree / force-push), for the next trigger or a manual Rebuild. */
export function clearPause(ctx: Ctx, branchId: number): void {
  ctx.db.update(branches).set({ pausedReason: null }).where(eq(branches.id, branchId)).run();
}
