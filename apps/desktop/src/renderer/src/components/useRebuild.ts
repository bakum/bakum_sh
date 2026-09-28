import { notifications } from '@mantine/notifications';
import type { BranchView } from '@bm/shared';
import { call, errorText } from '../lib/bm';

/** Rebuild with a notification; errors (legacy project, missing folder, active build) are shown as they are. */
export function useRebuild() {
  return async (b: BranchView, trigger: 'rebuild' | 'stage_change' = 'rebuild') => {
    try {
      await call('builds.rebuild', { branchId: b.id, trigger });
      notifications.show({ message: `Сборка ${b.name} поставлена в очередь` });
    } catch (e) {
      notifications.show({ color: 'red', title: 'Сборка не запущена', message: errorText(e), autoClose: 12000 });
    }
  };
}
