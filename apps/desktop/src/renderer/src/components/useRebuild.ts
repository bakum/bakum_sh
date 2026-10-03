import { notifications } from '@mantine/notifications';
import type { BranchView } from '@bm/shared';
import { call, errorText } from '../lib/bm';
import { t } from '../i18n';

/**
 * Rebuild with a notification; errors (legacy project, missing folder, active build) are shown as they are. A branch
 * behind the code of its copied database (D47) asks first when the missing commits change modules: the build would
 * run older module code on that database. Without such modules the lag is harmless and Rebuild runs at once.
 */
export function useRebuild() {
  return async (b: BranchView, trigger: 'rebuild' | 'stage_change' = 'rebuild') => {
    const lag = b.badges.find((x) => x.kind === 'behind-source' || x.kind === 'merged-behind');
    if (lag && b.codeLag?.modules.length) {
      const r = await window.bm.desktop.confirm({
        message: t('rebuild.lagQuestion', { branch: b.name }),
        detail: lag.text,
        buttons: [t('rebuild.anyway'), t('common.cancel')],
      });
      if (r !== 0) return;
    }
    try {
      await call('builds.rebuild', { branchId: b.id, trigger });
      notifications.show({ message: t('rebuild.queued', { branch: b.name }) });
    } catch (e) {
      notifications.show({ color: 'red', title: t('rebuild.failed'), message: errorText(e), autoClose: 12000 });
    }
  };
}
