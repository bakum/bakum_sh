import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  Code,
  Group,
  Menu,
  Pagination,
  Select,
  Stack,
  Text,
  Timeline,
  Tooltip,
} from '@mantine/core';
import { IconCheck, IconChevronDown, IconClock, IconPlayerPlay, IconX } from '@tabler/icons-react';
import { Spinner } from '../../components/Spinner';
import { notifications } from '@mantine/notifications';
import type { BranchView, BuildView } from '@bm/shared';
import { useBm } from '../../lib/query';
import { call, errorText } from '../../lib/bm';
import { fmtDate, fmtDuration, shortSha } from '../../lib/format';
import { shellOpen } from '../BranchPage';

const PAGE = 10;

const TRIGGER: Record<string, string> = {
  new_commit: 'новый коммит',
  rebuild: 'Rebuild',
  manual: 'вручную',
  import_backup: 'импорт бэкапа',
  stage_change: 'смена стадии',
};

function dbSourceText(s: string): string {
  if (s.startsWith('backup:')) return `из бэкапа ${s.slice(7)}`;
  if (s.startsWith('copy:')) return `копия БД ${s.slice(5)}`;
  if (s.startsWith('update:')) return `обновление БД сборки ${s.slice(7)}`;
  if (s === 'fresh') return 'чистая БД';
  return s;
}

async function act(p: Promise<unknown>, ok?: string) {
  try {
    await p;
    if (ok) notifications.show({ message: ok });
  } catch (e) {
    notifications.show({ color: 'red', title: 'Ошибка', message: errorText(e), autoClose: 12000 });
  }
}

/** History (spec 8.9): builds timeline with CONNECT, DROPPED, steps, «Повторить с шага», «Отбросить». */
export function HistoryTab({ branch }: { branch: BranchView }) {
  const [page, setPage] = useState(1);
  const q = useBm('builds.list', { branchId: branch.id, offset: (page - 1) * PAGE, limit: PAGE }, { refetchInterval: branch.activeBuild ? 2000 : 8000 });
  const items = q.data?.items ?? [];
  if (q.data && !items.length) {
    return (
      <Alert color="gray" variant="light">
        Сборок ещё не было. Нажмите Rebuild, чтобы собрать ветку по правилам стадии {branch.stage}.
      </Alert>
    );
  }
  return (
    <Stack>
      <Timeline bulletSize={30} lineWidth={2}>
        {items.map((b) => (
          <Timeline.Item key={b.id} bullet={<Avatar size={28} radius="xl" color="plum">{(b.commits[0]?.author ?? '?').slice(0, 1).toUpperCase()}</Avatar>}>
            <BuildCard b={b} branch={branch} />
          </Timeline.Item>
        ))}
      </Timeline>
      {(q.data?.total ?? 0) > PAGE && <Pagination total={Math.ceil(q.data!.total / PAGE)} value={page} onChange={setPage} size="sm" />}
    </Stack>
  );
}

function BuildCard({ b, branch }: { b: BuildView; branch: BranchView }) {
  const nav = useNavigate();
  const [more, setMore] = useState(false);
  const [retryStep, setRetryStep] = useState<string | null>(null);
  const author = b.commits[0]?.author ?? 'git';
  const commits = more ? b.commits : b.commits.slice(0, 3);
  const building = b.status === 'building' || b.status === 'queued';
  const failedStep = b.steps.find((s) => s.status === 'failed')?.name ?? null;
  return (
    <Card withBorder padding="sm" data-testid={`build-${b.number}`}>
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Stack gap={4} style={{ minWidth: 0 }}>
          <Group gap={8}>
            <Text fw={600} size="sm">
              {author}
            </Text>
            <Text size="xs" c="dimmed">
              {fmtDate(b.createdAt)} · сборка #{b.number} · {TRIGGER[b.trigger] ?? b.trigger} · {b.kind === 'update' ? 'update' : 'new'}
            </Text>
          </Group>
          {commits.map((c) => (
            <Group key={c.sha} gap={6} wrap="nowrap">
              <Code>{shortSha(c.sha)}</Code>
              <Text size="sm" truncate>
                {c.message}
              </Text>
            </Group>
          ))}
          {!b.commits.length && b.commitSha && (
            <Group gap={6}>
              <Code>{shortSha(b.commitSha)}</Code>
              <Text size="sm" c="dimmed">
                нет новых коммитов с прошлой сборки
              </Text>
            </Group>
          )}
          {b.commits.length > 3 && !more && (
            <Text size="xs" c="teal" style={{ cursor: 'pointer' }} onClick={() => setMore(true)}>
              {b.commits.length - 3} commits more
            </Text>
          )}
          <Group gap={6} mt={4}>
            <Badge variant="light" color="gray" size="sm">
              {dbSourceText(b.dbSource)}
            </Badge>
            <Badge variant="light" color="gray" size="sm">
              БД {b.dbName}
            </Badge>
            <Tooltip label="Тесты сборок — этап 2">
              <Badge variant="outline" color="gray" size="sm">
                Test: —
              </Badge>
            </Tooltip>
            <Badge variant="light" color="gray" size="sm" leftSection={<IconClock size={10} />}>
              {fmtDuration(b.createdAt, b.finishedAt)}
            </Badge>
            {b.dropAt && (
              <Tooltip label="dropAfterDays: автоматическое удаление — этап 2">
                <Badge variant="light" color="orange" size="sm">
                  будет удалена {fmtDate(b.dropAt).slice(0, 10)}
                </Badge>
              </Tooltip>
            )}
          </Group>
        </Stack>
        <Stack gap={6} align="flex-end">
          {b.isLive ? (
            <ConnectButton b={b} />
          ) : b.status === 'dropped' ? (
            <Badge color="gray" size="lg" variant="outline">
              DROPPED
            </Badge>
          ) : b.status === 'failed' ? (
            <Badge color="red" size="lg">
              FAILED
            </Badge>
          ) : building ? (
            <Badge color="orange" size="lg" leftSection={b.status === 'queued' ? <IconClock size={12} /> : <Spinner size={12} />}>
              {b.status === 'queued' ? 'В ОЧЕРЕДИ' : 'СБОРКА'}
            </Badge>
          ) : null}
          {b.isLive && b.containerState && b.containerState !== 'running' && (
            <Badge color="gray" variant="light">
              контейнер: {b.containerState}
            </Badge>
          )}
        </Stack>
      </Group>

      {(building || b.status === 'failed') && (
        <Group gap={6} mt="xs">
          {b.steps.map((s) => (
            <Badge
              key={s.name}
              size="sm"
              variant={s.status === 'pending' ? 'outline' : 'light'}
              color={s.status === 'success' ? 'teal' : s.status === 'failed' ? 'red' : s.status === 'running' ? 'orange' : 'gray'}
              leftSection={s.status === 'success' ? <IconCheck size={10} /> : s.status === 'failed' ? <IconX size={10} /> : s.status === 'running' ? <Spinner size={10} /> : null}
            >
              {s.name}
              {s.note ? ` · ${s.note}` : ''}
            </Badge>
          ))}
          {building && (
            <Button size="compact-xs" variant="subtle" onClick={() => nav(`/projects/${branch.projectId}/branches/${branch.id}/logs?build=${b.id}`)}>
              Лог сборки
            </Button>
          )}
        </Group>
      )}

      {b.status === 'failed' && (
        <Alert color="red" mt="xs" variant="light">
          <Stack gap={6}>
            <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
              {b.errorMessage ?? 'Сборка завершилась с ошибкой'}
            </Text>
            <Group gap={6}>
              <Select
                size="xs"
                w={180}
                placeholder="Шаг"
                data={b.steps.filter((s) => s.name !== 'tests').map((s) => s.name)}
                value={retryStep ?? failedStep}
                onChange={setRetryStep}
              />
              <Button size="xs" leftSection={<IconPlayerPlay size={12} />} onClick={() => void act(call('builds.retry', { buildId: b.id, fromStep: retryStep ?? failedStep ?? 'code' }), 'Сборка перезапущена')}>
                Повторить с шага
              </Button>
              <Button
                size="xs"
                color="red"
                variant="light"
                onClick={async () => {
                  const r = await window.bm.desktop.confirm({
                    message: `Отбросить сборку #${b.number}?`,
                    detail: 'Будут удалены созданные ею БД, filestore и контейнер. Живая сборка ветки не затрагивается.',
                    buttons: ['Отбросить', 'Отмена'],
                  });
                  if (r === 0) await act(call('builds.drop', { buildId: b.id }), 'Сборка отбрасывается');
                }}
              >
                Отбросить
              </Button>
              <Button size="xs" variant="subtle" onClick={() => nav(`/projects/${branch.projectId}/branches/${branch.id}/logs?build=${b.id}`)}>
                Лог сборки
              </Button>
            </Group>
          </Stack>
        </Alert>
      )}
    </Card>
  );
}

export function ConnectButton({ b }: { b: BuildView }) {
  const running = b.status === 'running' && (b.containerState === null || b.containerState === 'running');
  return (
    <Group gap={0} wrap="nowrap">
      <Button
        color="teal"
        disabled={!running || !b.url}
        style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
        onClick={() => b.url && void window.bm.desktop.openExternal(b.url)}
        data-testid="connect"
      >
        CONNECT
      </Button>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <Button color="teal" px={6} style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeft: '1px solid rgba(255,255,255,.4)' }} aria-label="Ещё">
            <IconChevronDown size={14} />
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item disabled={!running} onClick={() => void shellOpen({ buildId: b.id, target: 'browser' })}>
            Открыть
          </Menu.Item>
          <Menu.Item disabled={!running} onClick={() => void shellOpen({ buildId: b.id, target: 'browser-debug' })}>
            Открыть в режиме отладки (?debug=1)
          </Menu.Item>
          <Menu.Item
            onClick={async () => {
              const c = await call('builds.credentials', { buildId: b.id });
              await window.bm.desktop.copy(`${c.login ?? 'admin'} / ${c.password ?? '(пароль прода)'}`);
              notifications.show({ message: `Скопировано: логин ${c.login ?? 'admin'}` });
            }}
          >
            Скопировать логин / пароль admin
          </Menu.Item>
          <Menu.Item onClick={() => b.url && void window.bm.desktop.copy(b.url)}>Скопировать URL</Menu.Item>
          <Menu.Divider />
          {running ? (
            <Menu.Item onClick={() => void act(call('builds.action', { buildId: b.id, action: 'stop' }), 'Остановка…')}>Stop</Menu.Item>
          ) : (
            <Menu.Item onClick={() => void act(call('builds.action', { buildId: b.id, action: 'start' }), 'Запуск…')}>Start</Menu.Item>
          )}
          <Menu.Item onClick={() => void act(call('builds.action', { buildId: b.id, action: 'restart' }), 'Перезапуск…')}>Restart</Menu.Item>
          {b.configChanged && (
            <Menu.Item onClick={() => void act(call('builds.action', { buildId: b.id, action: 'apply-config' }), 'Контейнер пересоздаётся…')}>
              Применить конфигурацию
            </Menu.Item>
          )}
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}
