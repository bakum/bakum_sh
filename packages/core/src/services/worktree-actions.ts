import type { Ctx } from '../context';
import { resolveBranchScope } from '../config/effective';
import { ensureWorktree } from '../git/worktrees';
import { mustBranch } from './branches';
import { localWatcher } from './watch-local';
import { bus } from '../events';

/** Creates the branch worktree on demand (Editor / Clone before the first build). */
export async function ensureBranchWorktree(ctx: Ctx, branchId: number): Promise<{ path: string }> {
  const b = mustBranch(ctx, branchId);
  const cfg = ctx.store.require(b.projectId);
  const scope = resolveBranchScope(cfg, b.name, b.stage, b.overrides).scope;
  const p = await ensureWorktree(ctx, cfg, b, scope.tracking);
  await localWatcher()?.sync();
  bus.emit({ type: 'branch.changed', projectId: b.projectId, branchId });
  return { path: p };
}
