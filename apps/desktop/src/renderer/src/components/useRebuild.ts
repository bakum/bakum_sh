import { notifications } from '@mantine/notifications';
import type { BranchView } from '@bm/shared';
import { call, errorCode, errorText } from '../lib/bm';

/**
 * Rebuild with the special handling of criterion 12: a branch open in the main checkout cannot have a local
 * worktree — offer to switch it to tracking: remote instead of failing silently.
 */
export function useRebuild() {
  return async (b: BranchView, trigger: 'rebuild' | 'stage_change' = 'rebuild') => {
    try {
      await call('builds.rebuild', { branchId: b.id, trigger });
      notifications.show({ message: `Сборка ${b.name} поставлена в очередь` });
    } catch (e) {
      const code = errorCode(e);
      if (code === 'BRANCH_IN_MAIN_CHECKOUT' || code === 'BRANCH_IN_OTHER_WORKTREE') {
        const r = await window.bm.desktop.confirm({
          message: 'Ветка открыта в основном чекауте',
          detail: `${errorText(e)}\n\nПереключить ветку на tracking: remote и собрать?`,
          buttons: ['Переключить на tracking: remote', 'Отмена'],
        });
        if (r === 0) {
          try {
            const eff = await call('config.effective', { branchId: b.id });
            await call('branches.setOverrides', { branchId: b.id, overrides: { ...eff.branchOverrides, tracking: 'remote' } });
            await call('builds.rebuild', { branchId: b.id, trigger });
            notifications.show({ message: `Ветка ${b.name} переключена на tracking: remote, сборка поставлена в очередь` });
          } catch (e2) {
            notifications.show({ color: 'red', title: 'Ошибка', message: errorText(e2), autoClose: 12000 });
          }
        }
        return;
      }
      notifications.show({ color: 'red', title: 'Сборка не запущена', message: errorText(e), autoClose: 12000 });
    }
  };
}
