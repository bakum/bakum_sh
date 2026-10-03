import { BmError, isLegacyProject, type ProjectConfig } from '@bm/shared';
import { t } from '../i18n';

export const legacyText = (): string => t('legacy.text');

/** Builds, fetch and Fork need the app's mirror (D33); a legacy project can only be deleted. */
export function assertNotLegacy(cfg: ProjectConfig): void {
  if (isLegacyProject(cfg)) throw new BmError('LEGACY_PROJECT', legacyText());
}
