import type { BranchView } from '@bm/shared';
import { t } from '../i18n';

/**
 * Why actions on the build of a branch are disabled (D59): another branch is open in the user's folder. Only Stop stays
 * available; null — nothing blocks them.
 */
export function folderBlockHint(b: Pick<BranchView, 'folderBlocked' | 'folderBranch' | 'name'>): string | null {
  return b.folderBlocked ? t('common.folderBlocked', { open: b.folderBranch, branch: b.name }) : null;
}
