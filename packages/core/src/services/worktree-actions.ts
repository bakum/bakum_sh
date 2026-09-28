import type { Ctx } from '../context';
import { resolveBranchScope } from '../config/effective';
import { codeSource, ensureWorktree } from '../git/worktrees';
import { assertNotLegacy } from '../config/legacy';
import { mustBranch } from './branches';
import { localWatcher } from './watch-local';
import { bus } from '../events';

/** Code folder of the branch on demand (Editor / Clone before the first build): the user's folder or the worktree. */
export async function ensureBranchWorktree(ctx: Ctx, branchId: number): Promise<{ path: string }> {
  const b = mustBranch(ctx, branchId);
  const cfg = ctx.store.require(b.projectId);
  const scope = resolveBranchScope(cfg, b.name, b.stage, b.overrides).scope;
  if (scope.folder) return { path: codeSource(cfg, b, scope).dir! };
  assertNotLegacy(cfg);
  const p = await ensureWorktree(ctx, cfg, b);
  await localWatcher()?.sync();
  bus.emit({ type: 'branch.changed', projectId: b.projectId, branchId });
  return { path: p };
}
