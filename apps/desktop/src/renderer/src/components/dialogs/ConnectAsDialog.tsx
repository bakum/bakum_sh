import { useState } from 'react';
import { Alert, Button, Group, Loader, Modal, ScrollArea, Stack, Table, Text, TextInput } from '@mantine/core';
import { IconChevronRight, IconSearch } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import type { BuildView } from '@bm/shared';
import { useBm } from '../../lib/query';
import { call, errorText } from '../../lib/bm';
import { t } from '../../i18n';

/** «Войти как» (D66, as odoo.sh Connect as): internal users of the build's database, a click opens the build as one. */
export function ConnectAsDialog({ build, opened, onClose }: { build: BuildView; opened: boolean; onClose: () => void }) {
  const users = useBm('builds.users', { buildId: build.id }, { enabled: opened, staleTime: 0 });
  const [filter, setFilter] = useState('');
  const [login, setLogin] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const all = users.data?.items ?? [];
  const f = filter.trim().toLowerCase();
  const items = f ? all.filter((u) => u.name.toLowerCase().includes(f) || u.login.toLowerCase().includes(f)) : all;

  const connect = async (l: string) => {
    setBusy(l);
    try {
      await call('builds.connectAs', { buildId: build.id, login: l });
      onClose();
    } catch (e) {
      notifications.show({ color: 'red', title: t('connectAs.failed', { login: l }), message: errorText(e), autoClose: 12000 });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} size="xl" title={t('connectAs.title', { count: users.data ? ` (${all.length})` : '' })}>
      <Stack gap="sm">
        <Group grow align="flex-start">
          <TextInput
            placeholder={t('connectAs.search')}
            leftSection={<IconSearch size={14} />}
            value={filter}
            onChange={(e) => setFilter(e.currentTarget.value)}
            data-autofocus
          />
          <Group gap={0} wrap="nowrap">
            <TextInput
              placeholder={t('connectAs.byLogin')}
              value={login}
              onChange={(e) => setLogin(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && login.trim() && !busy && void connect(login.trim())}
              style={{ flex: 1 }}
              styles={{ input: { borderTopRightRadius: 0, borderBottomRightRadius: 0 } }}
            />
            <Button
              color="teal"
              disabled={!login.trim() || !!busy}
              loading={busy !== null && busy === login.trim()}
              onClick={() => void connect(login.trim())}
              style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0 }}
            >
              {t('connectAs.login')}
            </Button>
          </Group>
        </Group>
        <Text size="xs" c="dimmed">
          {t('connectAs.hint', { url: build.url ?? t('connectAs.buildAddress') })}
        </Text>
        {users.error && (
          <Alert color="red" variant="light">
            {errorText(users.error)}
          </Alert>
        )}
        {users.isLoading ? (
          <Group justify="center" py="lg">
            <Loader size="sm" />
          </Group>
        ) : (
          <ScrollArea.Autosize mah="60vh">
            <Table striped highlightOnHover verticalSpacing={6}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('connectAs.name')}</Table.Th>
                  <Table.Th>{t('connectAs.loginCol')}</Table.Th>
                  <Table.Th w={110} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {items.map((u) => (
                  <Table.Tr key={u.id}>
                    <Table.Td>{u.name}</Table.Td>
                    <Table.Td>{u.login}</Table.Td>
                    <Table.Td>
                      <Button
                        size="compact-sm"
                        variant="subtle"
                        color="teal"
                        leftSection={<IconChevronRight size={14} />}
                        loading={busy === u.login}
                        disabled={!!busy && busy !== u.login}
                        onClick={() => void connect(u.login)}
                        data-testid="connect-as-user"
                      >
                        {t('connectAs.login')}
                      </Button>
                    </Table.Td>
                  </Table.Tr>
                ))}
                {!items.length && users.data && (
                  <Table.Tr>
                    <Table.Td colSpan={3}>
                      <Text size="sm" c="dimmed">
                        {t(f ? 'connectAs.nobody' : 'connectAs.noUsers')}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
          </ScrollArea.Autosize>
        )}
      </Stack>
    </Modal>
  );
}
