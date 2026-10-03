import { useState } from 'react';
import { Alert, Badge, Button, Card, Code, Group, SimpleGrid, Stack, TagsInput, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconBug, IconCopy, IconDatabase, IconKey } from '@tabler/icons-react';
import type { BranchView } from '@bm/shared';
import { dockerDownHint, useBm, useBmMutation, useDockerOk } from '../../lib/query';
import { call, errorText } from '../../lib/bm';
import { shellOpen } from '../BranchPage';
import { folderBlockHint } from '../../lib/folder-block';
import { t } from '../../i18n';

/** Tools (spec 8.9): psql, connection string, admin password, manual modules, Debug (launch.json). */
export function ToolsTab({ branch }: { branch: BranchView }) {
  const live = branch.liveBuild;
  const changed = useBm('builds.changedModules', { branchId: branch.id }, { enabled: !!live });
  const launch = useBm('builds.launchJson', { buildId: live?.id ?? 0 }, { enabled: !!live });
  const resetPw = useBmMutation('builds.resetAdminPassword', { success: t('tools.pwReset') });
  const mods = useBmMutation('builds.modulesAction', { success: t('tools.jobQueued') });
  const [install, setInstall] = useState<string[]>([]);
  const [update, setUpdate] = useState<string[]>([]);
  const tests = useBmMutation('builds.testsAction', { success: t('tools.testsQueued') });
  const [testMods, setTestMods] = useState<string[]>([]);
  const dockerOk = useDockerOk();
  const blocked = folderBlockHint(branch);
  // D63: module and test jobs need Docker.
  const off = blocked ?? (dockerOk ? null : dockerDownHint());
  if (!live) return <Alert color="gray">{t('tab.noLive')}</Alert>;

  return (
    <SimpleGrid cols={2}>
      <Card withBorder>
        <Stack>
          <Title order={5}>{t('tools.database')}</Title>
          <Text size="sm">
            {t('tools.db')} <Code>{live.dbName}</Code>
          </Text>
          <Group>
            <Button leftSection={<IconDatabase size={14} />} onClick={() => void shellOpen({ buildId: live.id, target: 'psql' })}>
              {t('tools.psql')}
            </Button>
            <Button
              variant="default"
              leftSection={<IconCopy size={14} />}
              onClick={async () => {
                try {
                  const r = await call('builds.connectionString', { buildId: live.id });
                  await window.bm.desktop.copy(r.value);
                  notifications.show({ message: t('tools.connCopied') });
                } catch (e) {
                  notifications.show({ color: 'red', message: errorText(e) });
                }
              }}
            >
              {t('tools.copyConn')}
            </Button>
          </Group>
          <Group>
            <Button
              variant="default"
              leftSection={<IconKey size={14} />}
              loading={resetPw.isPending}
              onClick={async () => {
                const r = await window.bm.desktop.confirm({ message: t('tools.resetQ'), buttons: [t('tools.reset'), t('common.cancel')] });
                if (r === 0) resetPw.mutate({ buildId: live.id });
              }}
            >
              {t('tools.resetPw')}
            </Button>
          </Group>
        </Stack>
      </Card>

      <Card withBorder>
        <Stack>
          <Group justify="space-between">
            <Title order={5}>Debug</Title>
            <Badge variant="light">debugPort {live.debugPort ?? '—'}</Badge>
          </Group>
          <Text size="sm" c="dimmed">
            {t('tools.debugHint')}
          </Text>
          {launch.data && (
            <Code block style={{ maxHeight: 180, overflow: 'auto' }}>
              {launch.data.json}
            </Code>
          )}
          <Group>
            <Button
              leftSection={<IconCopy size={14} />}
              variant="default"
              onClick={() => launch.data && void window.bm.desktop.copy(launch.data.json).then(() => notifications.show({ message: t('tools.launchCopied') }))}
            >
              {t('tools.copyLaunch')}
            </Button>
            <Button
              leftSection={<IconBug size={14} />}
              onClick={async () => {
                try {
                  const r = await call('builds.writeLaunchJson', { buildId: live.id });
                  notifications.show({
                    color: r.gitignoreWarning ? 'orange' : 'green',
                    message: t('tools.added', { path: r.path }) + (r.gitignoreWarning ? t('tools.gitignore') : ''),
                    autoClose: 10000,
                  });
                } catch (e) {
                  notifications.show({ color: 'red', message: errorText(e) });
                }
              }}
            >
              {t('tools.addLaunch')}
            </Button>
          </Group>
        </Stack>
      </Card>

      <Card withBorder>
        <Stack>
          <Title order={5}>{t('tools.changed')}</Title>
          {blocked ? (
            <Text size="sm" c="dimmed">
              {t('tools.otherBranch')}
            </Text>
          ) : changed.data ? (
            <>
              <Text size="xs" c="dimmed">
                {changed.data.from ? `${changed.data.from.slice(0, 7)}..${changed.data.to?.slice(0, 7)}` : t('tools.noBase')} · {t('tools.files', { n: changed.data.files })}
              </Text>
              <Group gap={4}>
                {changed.data.modules.map((m) => (
                  <Badge key={m.name} color={m.action === 'update' ? 'teal' : m.action === 'install' ? 'blue' : m.action === 'removed' ? 'red' : 'gray'} variant="light">
                    {m.name}: {m.action === 'update' ? '-u' : m.action === 'install' ? '-i' : m.action === 'removed' ? t('tools.removed') : t('tools.notInstalled')}
                  </Badge>
                ))}
                {!changed.data.modules.length && <Text size="sm">{t('tools.noChanged')}</Text>}
              </Group>
            </>
          ) : (
            <Text size="sm" c="dimmed">…</Text>
          )}
        </Stack>
      </Card>

      <Card withBorder>
        <Stack>
          <Title order={5}>{t('tools.manual')}</Title>
          {off && (
            <Alert color="red" variant="light" py={6} data-testid="tools-blocked">
              <Text size="sm">{off}</Text>
            </Alert>
          )}
          <TagsInput label={t('tools.install')} value={install} onChange={setInstall} placeholder={t('tools.moduleName')} />
          <TagsInput label={t('tools.update')} value={update} onChange={setUpdate} placeholder={t('tools.moduleName')} />
          <Group justify="flex-end">
            <Button
              disabled={!!off || (!install.length && !update.length)}
              loading={mods.isPending}
              onClick={() => mods.mutate({ buildId: live.id, install, update }, { onSuccess: () => { setInstall([]); setUpdate([]); } })}
            >
              {t('tools.run')}
            </Button>
          </Group>
          <TagsInput
            label={t('tools.testsLabel')}
            description={t('tools.testsHint')}
            value={testMods}
            onChange={setTestMods}
            placeholder={t('tools.moduleName')}
          />
          <Group justify="flex-end">
            <Button
              variant="default"
              disabled={!!off || !testMods.length}
              loading={tests.isPending}
              onClick={() => tests.mutate({ buildId: live.id, modules: testMods })}
            >
              {t('tools.runTests')}
            </Button>
          </Group>
        </Stack>
      </Card>
    </SimpleGrid>
  );
}
