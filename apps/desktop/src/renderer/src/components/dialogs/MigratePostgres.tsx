import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Code, Group, List, Modal, ScrollArea, Stack, Text } from '@mantine/core';
import { useBm, useBmMutation } from '../../lib/query';
import { fmtBytes } from '../../lib/format';

const DONE = ['success', 'failed', 'cancelled', 'interrupted'];

/**
 * «Перевести на свой Postgres»: a project on an external Postgres (the user's own stack) gets the app's container
 * bm-<project>-db; the databases of the builds are copied, the live builds are recreated in the project network.
 */
export function MigratePostgresCard({ projectId, external }: { projectId: string; external: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [jobId, setJobId] = useState<number | null>(null);
  const pv = useBm('projects.pgMigratePreview', { projectId }, { enabled: open && !jobId });
  const start = useBmMutation('projects.pgMigrate');
  const cancel = useBmMutation('jobs.cancel');
  const job = useBm('jobs.get', { jobId: jobId ?? 1 }, { enabled: !!jobId, refetchInterval: (q) => (q.state.data && DONE.includes(q.state.data.status) ? false : 1000) });
  const running = !!jobId && !(job.data && DONE.includes(job.data.status));
  const jlog = useBm('jobs.log', { jobId: jobId ?? 1, tail: 200 }, { enabled: !!jobId, refetchInterval: running ? 1000 : false });

  // The project settings change at the end of the job: the forms reload them.
  useEffect(() => {
    if (job.data && DONE.includes(job.data.status)) void qc.invalidateQueries();
  }, [job.data?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const d = pv.data;
  const total = d?.databases.reduce((s, x) => s + (x.sizeBytes ?? 0), 0) ?? 0;
  const close = () => {
    setOpen(false);
    if (!running) setJobId(null);
  };

  // Stays mounted after the move (the project is managed then): the dialog keeps showing the log and the result.
  return (
    <>
      {external && (
        <Card withBorder mb="md">
          <Group justify="space-between" wrap="nowrap">
            <Text size="sm">
              Ветки работают на внешнем Postgres (обычно <Code>db</Code> вашего compose-проекта): если его остановить или удалить, сборки не
              запустятся. Свой Postgres приложения не зависит от вашего стенда.
            </Text>
            <Button variant="light" onClick={() => setOpen(true)} style={{ flexShrink: 0 }}>
              Перевести на свой Postgres…
            </Button>
          </Group>
        </Card>
      )}
      <Modal opened={open} onClose={close} title="Перевести проект на свой Postgres" size="lg">
        <Stack>
          {!jobId && !d && <Text size="sm">Проверка…</Text>}
          {!jobId && d && (
            <>
              <Text size="sm">
                <b>Сейчас:</b> {d.source.host}:{d.source.port}
                {d.source.container && (
                  <>
                    , контейнер <Code>{d.source.container}</Code>
                  </>
                )}
                {d.source.version ? `, PostgreSQL ${d.source.version}` : ''}
              </Text>
              {d.source.error && (
                <Alert color="yellow" variant="light">
                  Postgres недоступен{d.source.container ? ` — задача сначала запустит контейнер ${d.source.container}` : ''}: {d.source.error}
                </Alert>
              )}
              <Text size="sm">
                <b>Будет:</b> контейнер <Code>{d.target.container}</Code> (образ <Code>{d.target.image}</Code>), порт 127.0.0.1:{d.target.port ?? '—'}, сеть{' '}
                <Code>{d.target.network}</Code>
              </Text>
              <Stack gap={2}>
                <Text size="sm" fw={600}>
                  Базы для копирования (pg_dump → pg_restore): {d.databases.length}
                  {total ? `, ${fmtBytes(total)}` : ''}
                </Text>
                {!!d.databases.length && (
                  <List size="xs" spacing={0}>
                    {d.databases.map((x) => (
                      <List.Item key={x.name}>
                        <Code>{x.name}</Code> {x.sizeBytes != null ? fmtBytes(x.sizeBytes) : ''}
                      </List.Item>
                    ))}
                  </List>
                )}
              </Stack>
              {!!d.builds.length && (
                <Text size="sm">
                  <b>Живые сборки</b> ({d.builds.join(', ')}) на время копирования останавливаются и пересоздаются в сети {d.target.network}.
                </Text>
              )}
              <Alert color="blue" variant="light">
                Базы в прежнем Postgres не удаляются. Если что-то пойдёт не так, настройки проекта не меняются, а новый контейнер удаляется. Остальные
                задачи проекта ждут окончания перевода.
              </Alert>
              {d.blocker && <Alert color="red">{d.blocker}</Alert>}
              <Group justify="flex-end">
                <Button variant="default" onClick={close}>
                  Отмена
                </Button>
                <Button disabled={!!d.blocker} loading={start.isPending} onClick={() => start.mutate({ projectId }, { onSuccess: (r) => setJobId(r.jobId) })}>
                  Перевести
                </Button>
              </Group>
            </>
          )}
          {jobId && (
            <>
              {job.data?.status === 'failed' && <Alert color="red">{job.data.error}</Alert>}
              {job.data?.status === 'success' && (
                <Alert color="teal" variant="light">
                  Проект работает на своём Postgres.
                </Alert>
              )}
              <ScrollArea h={280} type="auto" bg="var(--mantine-color-gray-light)" p={6} style={{ borderRadius: 4 }}>
                <Text component="pre" size="xs" ff="monospace" m={0}>
                  {(jlog.data?.lines ?? []).join('\n') || 'ожидание…'}
                </Text>
              </ScrollArea>
              <Group justify="flex-end">
                {running && (
                  <Button color="red" variant="light" loading={cancel.isPending} onClick={() => cancel.mutate({ jobId })}>
                    Отменить
                  </Button>
                )}
                <Button variant="default" onClick={close}>
                  {running ? 'Скрыть' : 'Закрыть'}
                </Button>
              </Group>
            </>
          )}
        </Stack>
      </Modal>
    </>
  );
}
