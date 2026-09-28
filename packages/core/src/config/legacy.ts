import { BmError, isLegacyProject, type ProjectConfig } from '@bm/shared';

export const LEGACY_TEXT =
  'Проект создан по старой схеме: приложение работало внутри вашего репозитория. Удалите проект (Settings → «Удалить проект…») ' +
  'и добавьте заново — код сборок будет браться с GitHub, а ваш репозиторий приложение трогать не будет.';

/** Builds, fetch and Fork need the app's mirror (D33); a legacy project can only be deleted. */
export function assertNotLegacy(cfg: ProjectConfig): void {
  if (isLegacyProject(cfg)) throw new BmError('LEGACY_PROJECT', LEGACY_TEXT);
}
