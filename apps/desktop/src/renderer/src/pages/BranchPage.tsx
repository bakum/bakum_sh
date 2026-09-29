import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Alert, Badge, Box, Button, Group, Menu, Stack, Tabs, Text, Title, Tooltip } from '@mantine/core';
import {
  IconBrandGithub,
  IconChevronDown,
  IconCopy,
  IconDatabase,
  IconGitFork,
  IconGitMerge,
  IconRefresh,
  IconTerminal2,
  IconTrash,
} from '@tabler/icons-react';
import type { BranchView } from '@bm/shared';
import { useBm } from '../lib/query';
import { call, errorText } from '../lib/bm';
import { notifications } from '@mantine/notifications';
import { StatusDot } from '../components/StatusDot';
import { ForkDialog } from '../components/dialogs/ForkDialog';
import { DeleteDialog } from '../components/dialogs/DeleteDialog';
import { useRebuild } from '../components/useRebuild';
import { HistoryTab } from './branch/HistoryTab';
import { ShellTab } from './branch/ShellTab';
import { EditorTab } from './branch/EditorTab';
import { LogsTab } from './branch/LogsTab';
import { MonitorTab } from './branch/MonitorTab';
import { BackupsTab } from './branch/BackupsTab';
import { ToolsTab } from './branch/ToolsTab';
import { SettingsTab } from './branch/SettingsTab';
import { Placeholder } from '../components/Placeholder';

const STAGE_COLOR = { production: 'plum', development: 'teal' } as const;

export async function shellOpen(p: Parameters<typeof call<'shell.open'>>[1]) {
  try {
    const r = await call('shell.open', p);
    if (r.detail) notifications.show({ message: r.detail });
  } catch (e) {
    notifications.show({ color: 'red', title: 'Не удалось открыть', message: errorText(e), autoClose: 12000 });
  }
}

/** Branch page (spec 6 / 8.9). */
export function BranchPage({ branchId, projectId, onMerge }: { branchId: number; projectId: string; onMerge: (b: BranchView) => void }) {
  const { tab } = useParams();
  const nav = useNavigate();
  const q = useBm('branches.get', { branchId }, { refetchInterval: 5000 });
  const project = useBm('projects.get', { projectId });
  const [fork, setFork] = useState(false);
  const [del, setDel] = useState(false);
  const rebuild = useRebuild();
  const b = q.data;
  if (!b) return null;
  const active = tab ?? 'history';
  const github = project.data?.summary.github;
  const cfgUrl = project.data?.config?.repo.url;
  const repoUrl = cfgUrl ? cfgUrl.replace(/^(https:\/\/)[^@/]+@/, '$1') : github ? `https://github.com/${github}.git` : null;
  const live = b.liveBuild;
  const setTab = (t: string | null) => nav(`/projects/${projectId}/branches/${branchId}/${t ?? 'history'}`);

  return (
    <Stack gap={0} h="100%">
      <Box px="lg" pt="md" pb={6}>
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Stack gap={4} style={{ minWidth: 0 }}>
            <Group gap="xs" wrap="nowrap">
              <StatusDot indicator={b.indicator} size={12} />
              <Title order={3} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {b.name}
              </Title>
              <Badge color={STAGE_COLOR[b.stage]} variant="light">
                {b.stage}
              </Badge>
              {b.stage === 'production' && (
                <Tooltip label="Локальная копия, восстановленная из бэкапа прода. С боевым сервером приложение не соединяется.">
                  <Badge color="orange" variant="filled" data-testid="mirror-label">
                    Зеркало прода (локально)
                  </Badge>
                </Tooltip>
              )}
              {b.assignedBy === 'user' && b.stage !== 'production' && (
                <Tooltip label="Стадия зафиксирована вручную">
                  <Badge variant="outline" color="gray" size="sm">
                    вручную
                  </Badge>
                </Tooltip>
              )}
            </Group>
            <Text size="xs" c="dimmed">
              {b.slug} · {b.folder ? `код из вашей папки ${b.folder}` : `код с GitHub · ${b.worktreePath ?? 'worktree ещё не создан'}`}
              {b.url ? ` · ${b.url}` : ''}
            </Text>
          </Stack>
          <Group gap={6} wrap="nowrap">
            <Menu position="bottom-end">
              <Menu.Target>
                <Button variant="default" leftSection={<IconCopy size={14} />} rightSection={<IconChevronDown size={12} />}>
                  Clone
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item disabled={!b.codeDir} onClick={() => void window.bm.desktop.copy(b.codeDir ?? '')}>
                  Скопировать путь к коду
                </Menu.Item>
                <Menu.Item disabled={!repoUrl} onClick={() => void window.bm.desktop.copy(`git clone -b ${b.name} ${repoUrl}`)}>
                  Скопировать команду git clone
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
            <Button variant="default" leftSection={<IconGitFork size={14} />} onClick={() => setFork(true)}>
              Fork
            </Button>
            <Button variant="default" leftSection={<IconGitMerge size={14} />} onClick={() => onMerge(b)}>
              Merge
            </Button>
            <Button variant="default" leftSection={<IconTerminal2 size={14} />} disabled={!live} onClick={() => void shellOpen({ buildId: live!.id, target: 'bash' })}>
              Terminal
            </Button>
            <Button variant="default" leftSection={<IconDatabase size={14} />} disabled={!live} onClick={() => void shellOpen({ buildId: live!.id, target: 'psql' })}>
              SQL
            </Button>
            <Button variant="default" color="red" leftSection={<IconTrash size={14} />} disabled={b.stage === 'production'} onClick={() => setDel(true)}>
              Delete
            </Button>
          </Group>
        </Group>
        {b.badges.filter((x) => x.kind !== 'no-build').length > 0 && (
          <Stack gap={4} mt="xs">
            {b.badges
              .filter((x) => x.kind !== 'no-build')
              .map((x) => (
                <Alert
                  key={x.kind}
                  // D47: a lag is only a warning when the missing commits change modules; otherwise Rebuild is safe.
                  color={x.kind === 'discrepancy' ? 'red' : x.kind === 'behind-source' || x.kind === 'merged-behind' ? (b.codeLag?.modules.length ? 'yellow' : 'gray') : 'orange'}
                  variant="light"
                  py={4}
                  data-testid={`badge-${x.kind}`}
                >
                  <Group justify="space-between" wrap="nowrap">
                    <Text size="sm" style={{ whiteSpace: 'pre-line' }}>
                      {x.text}
                    </Text>
                    {(x.kind === 'stage-changed' || x.kind === 'unbuilt-commits' || x.kind === 'mirror-newer' || x.kind === 'force-push' || x.kind === 'dirty-worktree') && (
                      <Button size="compact-xs" onClick={() => rebuild(b, x.kind === 'stage-changed' ? 'stage_change' : 'rebuild')}>
                        Rebuild
                      </Button>
                    )}
                    {x.kind === 'config-changed' && live && (
                      <Button size="compact-xs" onClick={() => void call('builds.action', { buildId: live.id, action: 'apply-config' }).catch((e) => notifications.show({ color: 'red', message: errorText(e) }))}>
                        Применить
                      </Button>
                    )}
                  </Group>
                </Alert>
              ))}
          </Stack>
        )}
      </Box>
      <Tabs value={active} onChange={setTab} keepMounted={false} style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <Group justify="space-between" px="lg" wrap="nowrap" style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
          <Tabs.List style={{ border: 0 }}>
            <Tabs.Tab value="history">History</Tabs.Tab>
            <Tabs.Tab value="shell">Shell</Tabs.Tab>
            <Tabs.Tab value="editor">Editor</Tabs.Tab>
            <Tabs.Tab value="monitor">Monitor</Tabs.Tab>
            <Tabs.Tab value="logs">Logs</Tabs.Tab>
            <Tabs.Tab value="mails">Mails</Tabs.Tab>
            <Tabs.Tab value="backups">Backups</Tabs.Tab>
            <Tabs.Tab value="tools">Tools</Tabs.Tab>
            <Tabs.Tab value="settings">Settings</Tabs.Tab>
          </Tabs.List>
          <Group gap={6} wrap="nowrap">
            <Button leftSection={<IconRefresh size={14} />} loading={!!b.activeBuild} onClick={() => rebuild(b, 'rebuild')}>
              Rebuild
            </Button>
            <Button
              variant="default"
              leftSection={<IconBrandGithub size={14} />}
              disabled={!github}
              onClick={() => void window.bm.desktop.openExternal(`https://github.com/${github}/tree/${b.name}`)}
            >
              GitHub
            </Button>
          </Group>
        </Group>
        <Box style={{ flex: 1, minHeight: 0, overflow: 'auto' }} px="lg" py="md">
          <Tabs.Panel value="history">
            <HistoryTab branch={b} />
          </Tabs.Panel>
          <Tabs.Panel value="shell">
            <ShellTab branch={b} />
          </Tabs.Panel>
          <Tabs.Panel value="editor">
            <EditorTab branch={b} />
          </Tabs.Panel>
          <Tabs.Panel value="monitor">
            <MonitorTab branch={b} />
          </Tabs.Panel>
          <Tabs.Panel value="logs" h="100%">
            <LogsTab branch={b} />
          </Tabs.Panel>
          <Tabs.Panel value="mails">
            <Placeholder
              stage="отложено"
              what="Mailpit в сборках отложен. Письма из сборок наружу не уходят: в копиях прода почтовые серверы выключены нейтрализацией, в чистых БД их нет. Не включайте почтовый сервер вручную в сборке с копией прода — письма уйдут настоящим адресатам."
            />
          </Tabs.Panel>
          <Tabs.Panel value="backups">
            <BackupsTab branch={b} />
          </Tabs.Panel>
          <Tabs.Panel value="tools">
            <ToolsTab branch={b} />
          </Tabs.Panel>
          <Tabs.Panel value="settings">
            <SettingsTab branch={b} />
          </Tabs.Panel>
        </Box>
      </Tabs>
      <ForkDialog open={fork} branch={b} onClose={() => setFork(false)} />
      <DeleteDialog open={del} branch={b} onClose={() => setDel(false)} />
    </Stack>
  );
}
