import { useQuery } from '@tanstack/react-query';
import { Group, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { checkForUpdates, installUpdate, useUpdateState } from './UpdateBanner';

export const COPYRIGHT_HOLDER = 'Bakum Viacheslav';

/** Build info from main (version, commit, build date) — see docs/decisions.md D27. */
export function useBuildInfo() {
  return useQuery({ queryKey: ['desktop.info'], queryFn: () => window.bm.desktop.info(), staleTime: Infinity });
}

/** Bottom strip of the window: product, version, copyright. Click on the version copies it (for bug reports). */
export function AppFooter() {
  const info = useBuildInfo().data;
  const year = info ? new Date(info.buildDate).getFullYear() : new Date().getFullYear();
  const full = info ? `Odoo Branch Manager ${info.version} (${info.commit}), сборка ${new Date(info.buildDate).toLocaleString('ru-RU')}` : '';
  return (
    <Group
      justify="space-between"
      px="md"
      h={24}
      wrap="nowrap"
      style={{ flex: '0 0 24px', borderTop: '1px solid var(--mantine-color-default-border)', background: 'var(--mantine-color-default)' }}
      data-testid="app-footer"
    >
      <Tooltip label={`${full}. Нажмите, чтобы скопировать`} disabled={!info}>
        <UnstyledButton
          onClick={() => {
            if (!info) return;
            void window.bm.desktop.copy(full);
            notifications.show({ message: 'Версия скопирована' });
          }}
        >
          <Text size="xs" c="dimmed">
            Odoo Branch Manager {info ? `v${info.version} · ${info.commit}` : ''}
            {info?.profile ? ` · профиль ${info.profile}` : ''}
          </Text>
        </UnstyledButton>
      </Tooltip>
      <Group gap="md" wrap="nowrap">
        <FooterUpdateLink />
        <Text size="xs" c="dimmed">
          © {year} {COPYRIGHT_HOLDER}
        </Text>
      </Group>
    </Group>
  );
}

function FooterUpdateLink() {
  const s = useUpdateState();
  if (!s) return null;
  const available = s.status === 'available' || s.status === 'ready';
  return (
    <UnstyledButton onClick={() => void (available ? installUpdate() : checkForUpdates())} data-testid="footer-update">
      <Text size="xs" c={available ? 'blue' : 'dimmed'} td="underline">
        {s.status === 'checking' ? 'Проверка обновлений…' : available ? `Доступна версия ${s.latest} — обновить` : 'Проверить обновления'}
      </Text>
    </UnstyledButton>
  );
}
