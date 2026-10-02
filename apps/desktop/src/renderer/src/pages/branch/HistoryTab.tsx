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
import { TestsBadge } from '../../components/TestsBadge';
import { notifications } from '@mantine/notifications';
import type { BranchView, BuildView } from '@bm/shared';
import { DOCKER_DOWN_HINT, useBm, useDockerOk } from '../../lib/query';
import { call, errorText } from '../../lib/bm';
import { fmtDate, fmtDuration, shortSha, TRIGGER_LABELS } from '../../lib/format';
import { githubAvatarUrl } from '../../lib/avatar';
import { shellOpen } from '../BranchPage';
import { folderBlockHint } from '../../lib/folder-block';
import { ConnectAsDialog } from '../../components/dialogs/ConnectAsDialog';

const PAGE = 5;

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
  const total = q.data?.total ?? 0;
  const pages = Math.ceil(total / PAGE);
  // Builds were dropped and the page is gone: back to the last one.
  if (q.data && total && page > pages) setPage(pages);
  if (q.data && !total) {
    return (
      <Alert color="gray" variant="light">
        Сборок ещё не было. Нажмите Rebuild, чтобы собрать ветку по правилам стадии {branch.stage}.
      </Alert>
    );
  }
  return (
    <Stack>
      <Group justify="space-between" data-testid="history-header">
        <Text size="sm" c="dimmed">
          Сборок: {total}
        </Text>
        {pages > 1 && <Pagination total={pages} value={page} onChange={setPage} size="sm" />}
      </Group>
      <Timeline bulletSize={30} lineWidth={2}>
        {items.map((b) => (
          <Timeline.Item
            key={b.id}
            bullet={
              <Avatar size={28} radius="xl" color="plum" src={githubAvatarUrl(b.commits[0]?.email, 56)} alt={b.commits[0]?.author}>
                {(b.commits[0]?.author ?? '?').slice(0, 1).toUpperCase()}
              </Avatar>
            }
          >
            <BuildCard b={b} branch={branch} />
          </Timeline.Item>
        ))}
      </Timeline>
      {pages > 1 && (
        <Group justify="flex-end">
          <Pagination total={pages} value={page} onChange={setPage} size="sm" />
        </Group>
      )}
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
  const dockerOk = useDockerOk();
  const blocked = folderBlockHint(branch) ?? (dockerOk ? null : DOCKER_DOWN_HINT);
  return (
    <Card withBorder padding="sm" data-testid={`build-${b.number}`}>
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Stack gap={4} style={{ minWidth: 0 }}>
          <Group gap={8}>
            <Text fw={600} size="sm">
              {author}
            </Text>
            <Text size="xs" c="dimmed">
              {fmtDate(b.createdAt)} · сборка #{b.number} · {TRIGGER_LABELS[b.trigger] ?? b.trigger} · {b.kind === 'update' ? 'update' : 'new'}
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
            <TestsBadge tests={b.tests} onClick={() => nav(`/projects/${branch.projectId}/branches/${branch.id}/logs?build=${b.id}&source=tests`)} />
            <Badge variant="light" color="gray" size="sm" leftSection={<IconClock size={10} />}>
              {fmtDuration(b.createdAt, b.finishedAt)}
            </Badge>
            {b.dropAt && (
              <Tooltip
                multiline
                w={320}
                label="dropAfterDays: срок хранения живой сборки считается от последнего захода или новой сборки. По истечении приходит напоминание; отбросить — CONNECT ▾ → «Отбросить сборку…». Сама сборка не удаляется."
              >
                <Badge variant="light" color={new Date(b.dropAt).getTime() <= Date.now() ? 'red' : 'orange'} size="sm">
                  {new Date(b.dropAt).getTime() <= Date.now() ? 'срок хранения истёк — можно отбросить' : `хранить до ${fmtDate(b.dropAt).slice(0, 10)}`}
                </Badge>
              </Tooltip>
            )}
          </Group>
        </Stack>
        <Stack gap={6} align="flex-end">
          {b.isLive ? (
            <ConnectButton b={b} blocked={blocked} />
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
                data={b.steps.map((s) => s.name)}
                value={retryStep ?? failedStep}
                onChange={setRetryStep}
              />
              <Tooltip label={blocked} disabled={!blocked} multiline w={320}>
                <Button
                  size="xs"
                  leftSection={<IconPlayerPlay size={12} />}
                  data-disabled={blocked ? true : undefined}
                  onClick={() => !blocked && void act(call('builds.retry', { buildId: b.id, fromStep: retryStep ?? failedStep ?? 'code' }), 'Сборка перезапущена')}
                >
                  Повторить с шага
                </Button>
              </Tooltip>
              <Button
                size="xs"
                color="red"
                variant="light"
                disabled={!!blocked}
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

/** `blocked` — why actions on the build are disabled (D59); only Stop stays. */
export function ConnectButton({ b, blocked = null }: { b: BuildView; blocked?: string | null }) {
  // D63: without Docker the registry status is stale — the container may well be gone.
  const running = useDockerOk() && b.status === 'running' && (b.containerState === null || b.containerState === 'running');
  const [connectAs, setConnectAs] = useState(false);
  return (
    <Group gap={0} wrap="nowrap">
      {connectAs && <ConnectAsDialog build={b} opened onClose={() => setConnectAs(false)} />}
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
          <Menu.Item disabled={!running} onClick={() => setConnectAs(true)} data-testid="connect-as">
            Войти как…
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
          {blocked && (
            <Menu.Label maw={280} style={{ whiteSpace: 'normal' }} data-testid="folder-blocked">
              {blocked}
            </Menu.Label>
          )}
          {running ? (
            <Menu.Item onClick={() => void act(call('builds.action', { buildId: b.id, action: 'stop' }), 'Остановка…')}>Stop</Menu.Item>
          ) : (
            <Menu.Item disabled={!!blocked} onClick={() => void act(call('builds.action', { buildId: b.id, action: 'start' }), 'Запуск…')}>
              Start
            </Menu.Item>
          )}
          <Menu.Item disabled={!!blocked} onClick={() => void act(call('builds.action', { buildId: b.id, action: 'restart' }), 'Перезапуск…')}>
            Restart
          </Menu.Item>
          {b.configChanged && (
            <Menu.Item disabled={!!blocked} onClick={() => void act(call('builds.action', { buildId: b.id, action: 'apply-config' }), 'Контейнер пересоздаётся…')}>
              Применить конфигурацию
            </Menu.Item>
          )}
          {/* spec 11: the production mirror's database changes only through a backup import. */}
          {b.stage !== 'production' && (
            <>
              <Menu.Divider />
              <Menu.Item
                color="red"
                disabled={!!blocked}
                onClick={async () => {
                  const r = await window.bm.desktop.confirm({
                    message: `Отбросить живую сборку #${b.number}?`,
                    detail: `Будут удалены контейнер, БД ${b.dbName}, её filestore и снапшоты. Ветка и её код остаются, собрать заново — Rebuild.`,
                    buttons: ['Отбросить', 'Отмена'],
                  });
                  if (r === 0) await act(call('builds.drop', { buildId: b.id }), 'Сборка отбрасывается');
                }}
              >
                Отбросить сборку…
              </Menu.Item>
            </>
          )}
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}
