import { Alert, Badge, Button, Card, Checkbox, Code, Container, Group, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { IconCircleCheck, IconCircleX } from '@tabler/icons-react';
import { useBm, useBmMutation } from '../lib/query';
import { fmtAgo } from '../lib/format';
import { t, tx } from '../i18n';

function StatusRow({ ok, title, text }: { ok: boolean; title: string; text: string }) {
  return (
    <Group wrap="nowrap" align="flex-start">
      {ok ? <IconCircleCheck color="teal" size={20} /> : <IconCircleX color="red" size={20} />}
      <Stack gap={0}>
        <Text fw={600} size="sm">
          {title}
        </Text>
        <Text size="sm" c="dimmed">
          {text}
        </Text>
      </Stack>
    </Group>
  );
}

const orphanKind = (kind: string): string =>
  ({ database: t('status.database'), filestore: 'filestore', compose: t('status.compose'), container: t('status.container'), worktree: 'worktree' })[kind] ?? kind;

/** Status (spec 8.11/8.12): services, resources, fetches, reconciliation discrepancies and orphans. */
export function StatusPage() {
  const st = useBm('system.status', { refresh: true }, { refetchInterval: 10000 });
  const cleanup = useBmMutation('system.cleanupOrphans', { success: t('status.cleaned') });
  const appState = useBm('system.state', {});
  const [selected, setSelected] = useState<string[]>([]);
  const nav = useNavigate();
  const s = st.data;
  if (!s) return null;
  const orphanKey = (o: { kind: string; name: string }) => `${o.kind}:${o.name}`;
  return (
    <Container size="xl" py="md">
      <Stack>
        <Group justify="space-between">
          <Title order={3}>Status</Title>
          <Button variant="default" loading={st.isFetching} onClick={() => void st.refetch()}>
            {t('common.refresh')}
          </Button>
        </Group>
        <SimpleGrid cols={3}>
          <Card withBorder>
            <Stack>
              <StatusRow ok={s.docker.ok} title="Docker" text={s.docker.text} />
              <StatusRow ok={s.traefik.ok} title="Traefik" text={s.traefik.text} />
              <StatusRow ok={s.gh.ok} title="gh CLI" text={s.gh.text} />
            </Stack>
          </Card>
          <Card withBorder>
            <Stack>
              {Object.entries(s.postgres).map(([pid, p]) => (
                <StatusRow key={pid} ok={p.ok} title={`Postgres · ${pid}`} text={p.text} />
              ))}
              {!Object.keys(s.postgres).length && <Text size="sm" c="dimmed">{t('status.noProjects')}</Text>}
            </Stack>
          </Card>
          <Card withBorder>
            <Stack gap={6}>
              <StatusRow
                ok={!s.disk.low}
                title={t('status.freeSpace')}
                text={s.disk.freeGb === null ? t('status.unknown') : t('status.freeGb', { gb: s.disk.freeGb.toFixed(1) })}
              />
              <StatusRow
                ok={s.running.count <= s.running.limit}
                title={t('status.liveBuilds')}
                text={t('status.liveOf', { n: s.running.count, limit: s.running.limit })}
              />
              <StatusRow ok title={t('status.queue')} text={t('status.queueText', { running: s.queue.running, max: s.queue.maxParallel, queued: s.queue.queued })} />
            </Stack>
          </Card>
        </SimpleGrid>

        {s.outdatedSkills.map((k) => (
          <Alert key={k.projectId} color="orange" variant="light" data-testid="outdated-skill">
            <Group justify="space-between">
              <Text size="sm">
                {tx('status.skillOutdated', { id: k.projectId, path: k.path }, { code: (x) => <Code>{x}</Code> })}
              </Text>
              <Button size="compact-sm" variant="light" onClick={() => nav(`/projects/${k.projectId}/settings/agents`)}>
                {t('common.refresh')}
              </Button>
            </Group>
          </Alert>
        ))}

        <Card withBorder>
          <Text fw={600} mb="xs">
            {t('status.lastFetch')}
          </Text>
          <Table>
            <Table.Tbody>
              {s.fetches.map((f) => (
                <Table.Tr key={f.projectId}>
                  <Table.Td w={200}>{f.projectId}</Table.Td>
                  <Table.Td>{fmtAgo(f.at)}</Table.Td>
                  <Table.Td c={f.error ? 'red' : undefined}>{f.error ?? t('status.ok')}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Card>

        <Card withBorder>
          <Text fw={600} mb="xs">
            {t('status.reconcile')}
          </Text>
          {!s.discrepancies.length ? (
            <Text size="sm" c="dimmed">
              {t('status.noDiscrepancies')}
            </Text>
          ) : (
            <Table striped>
              <Table.Tbody>
                {s.discrepancies.map((d, i) => (
                  <Table.Tr key={i}>
                    <Table.Td w={120}>
                      <Badge color="orange" variant="light">
                        {d.projectId}
                      </Badge>
                    </Table.Td>
                    <Table.Td>{d.text}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Card>

        <Card withBorder>
          <Group justify="space-between" mb="xs">
            <Text fw={600}>{t('status.orphans')}</Text>
            <Button
              color="red"
              disabled={!selected.length}
              loading={cleanup.isPending}
              onClick={async () => {
                const r = await window.bm.desktop.confirm({ message: t('status.deleteSelectedQ', { n: selected.length }), detail: t('status.irreversible'), buttons: [t('common.delete'), t('common.cancel')] });
                if (r !== 0) return;
                cleanup.mutate({ items: s.orphans.filter((o) => selected.includes(orphanKey(o))) }, { onSuccess: () => setSelected([]) });
              }}
            >
              {t('status.deleteSelected')}
            </Button>
          </Group>
          {!s.orphans.length ? (
            <Text size="sm" c="dimmed">
              {t('status.noOrphans')}
            </Text>
          ) : (
            <Table>
              <Table.Tbody>
                {s.orphans.map((o) => (
                  <Table.Tr key={orphanKey(o)}>
                    <Table.Td w={40}>
                      <Checkbox
                        checked={selected.includes(orphanKey(o))}
                        onChange={(e) => {
                          // Read before setState: the updater may run after the event, when currentTarget is already null.
                          const checked = e.currentTarget.checked;
                          setSelected((x) => (checked ? [...x, orphanKey(o)] : x.filter((k) => k !== orphanKey(o))));
                        }}
                      />
                    </Table.Td>
                    <Table.Td w={140}>{orphanKind(o.kind)}</Table.Td>
                    <Table.Td>
                      <Code>{o.name}</Code>
                    </Table.Td>
                    <Table.Td>{o.projectId ?? '—'}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Card>

        <Alert variant="light" color="gray">
          <Group justify="space-between">
            <Text size="sm">
              {tx('status.paths', { version: appState.data?.version ?? '…', config: s.paths.configDir, data: s.paths.dataDir }, { code: (x) => <Code>{x}</Code> })}
            </Text>
            <Button variant="default" onClick={() => void window.bm.call('shell.open', { target: 'logs-dir' })}>
              {t('status.openLogs')}
            </Button>
          </Group>
        </Alert>
      </Stack>
    </Container>
  );
}
