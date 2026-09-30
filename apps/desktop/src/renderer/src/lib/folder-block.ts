import type { BranchView } from '@bm/shared';

/**
 * Why actions on the build of a branch are disabled (D59): another branch is open in the user's folder. Only Stop stays
 * available; null — nothing blocks them.
 */
export function folderBlockHint(b: Pick<BranchView, 'folderBlocked' | 'folderBranch' | 'name'>): string | null {
  return b.folderBlocked ? `В вашей папке открыта ветка ${b.folderBranch}, а не ${b.name}: сборка заблокирована. Работает только Stop.` : null;
}
