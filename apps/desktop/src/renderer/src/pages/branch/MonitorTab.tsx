import { useState } from 'react';
import { Alert, Button, Card, Group, Paper, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import { keepPreviousData } from '@tanstack/react-query';
import type { BranchView } from '@bm/shared';
import { useBm } from '../../lib/query';
import { fmtAgo, fmtBytes, fmtDate, fmtTime } from '../../lib/format';
import { MinuteBars, TimeLineChart } from '../../components/MonitorCharts';
import { t } from '../../i18n';

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Paper withBorder p="sm">
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="lg" fw={600}>
        {value}
      </Text>
      {hint && (
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      )}
    </Paper>
  );
}

const minuteMs = (m: string) => new Date(`${m}:00Z`).getTime();

/** Monitor (spec 8.9, D45): the last hour of CPU / RAM and requests, database and filestore sizes, lifecycle dates. */
export function MonitorTab({ branch }: { branch: BranchView }) {
  const live = branch.liveBuild;
  const q = useBm('monitor.get', { buildId: live?.id ?? 0 }, { enabled: !!live, refetchInterval: 15_000, placeholderData: keepPreviousData });
  const [table, setTable] = useState(false);
  if (!live) return <Alert color="gray">{t('monitor.noLive')}</Alert>;
  const m = q.data;
  if (!m) return null;
  const to = Date.now();
  const from = to - 3_600_000;
  const res = m.resources.map((s) => ({ t: new Date(s.at).getTime(), cpu: s.cpu, mem: s.memMb }));
  const last = res[res.length - 1];
  const reqs = m.requests.map((r) => ({ ...r, t: minuteMs(r.minute) }));
  const total = reqs.reduce((a, r) => a + r.count, 0);
  const avg = total ? Math.round(reqs.reduce((a, r) => a + r.avgMs * r.count, 0) / total) : null;
  const errors = reqs.reduce((a, r) => a + r.errors, 0);
  const byMinute = new Map(reqs.map((r) => [r.t, r]));
  return (
    <Stack style={{ opacity: q.isFetching && q.isPlaceholderData ? 0.6 : 1 }}>
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Tile label={t('monitor.cpuNow')} value={last ? `${last.cpu.toFixed(1)} %` : m.running ? '—' : t('monitor.stopped')} hint={t('monitor.oneCore')} />
        <Tile label={t('monitor.memNow')} value={last ? t('monitor.mb', { n: last.mem }) : '—'} hint={m.memLimitMb ? t('monitor.ofDocker', { n: m.memLimitMb }) : undefined} />
        <Tile
          label={t('monitor.reqHour')}
          value={String(total)}
          hint={avg !== null ? t('monitor.avg', { ms: avg }) + (errors ? t('monitor.errors5xx', { n: errors }) : '') : t('monitor.viaTraefik')}
        />
        <Tile label={t('monitor.lastVisit')} value={m.lastActiveAt ? fmtAgo(m.lastActiveAt) : '—'} hint={m.lastActiveAt ? fmtDate(m.lastActiveAt) : t('monitor.noRequests')} />
        <Tile label={t('monitor.dbSize')} value={fmtBytes(m.dbSizeBytes)} />
        <Tile label="Filestore" value={fmtBytes(m.filestoreBytes)} hint={t('monitor.filestoreHint')} />
        <Tile
          label={t('monitor.idleStop')}
          value={m.idleStopAt ? fmtDate(m.idleStopAt) : m.idleStopHours ? t('monitor.notRunningNow') : t('monitor.off')}
          hint={m.idleStopHours ? t('monitor.idleHint', { h: m.idleStopHours }) : 'idleStopHours: 0'}
        />
        <Tile
          label={t('monitor.retention')}
          value={m.expiresAt ? fmtDate(m.expiresAt) : t('monitor.noExpiry')}
          hint={m.dropAfterDays ? t('monitor.dropHint', { d: m.dropAfterDays }) : 'dropAfterDays: 0'}
        />
      </SimpleGrid>
      <Card withBorder>
        <Stack gap="lg">
          <TimeLineChart title={t('monitor.cpuChart')} points={res.map((r) => ({ t: r.t, v: r.cpu }))} format={(v) => `${Math.round(v)} %`} from={from} to={to} />
          <TimeLineChart
            title={t('monitor.memChart')}
            points={res.map((r) => ({ t: r.t, v: r.mem }))}
            format={(v) => `${Math.round(v)}`}
            from={from}
            to={to}
          />
          <MinuteBars
            title={t('monitor.reqChart')}
            bars={reqs.map((r) => ({ t: r.t, v: r.count }))}
            from={from}
            to={to}
            detail={(at) => {
              const r = byMinute.get(at);
              return t('monitor.reqDetail', { time: fmtTime(at, false), avg: r?.avgMs ?? 0, max: r?.maxMs ?? 0, errors: r?.errors ? `, 5xx: ${r.errors}` : '' });
            }}
          />
          <Group>
            <Button size="xs" variant="subtle" onClick={() => setTable((v) => !v)}>
              {t(table ? 'monitor.hideTable' : 'monitor.showTable')}
            </Button>
            <Text size="xs" c="dimmed">
              {t('monitor.sampling')}
            </Text>
          </Group>
          {table && (
            <SimpleGrid cols={{ base: 1, md: 2 }}>
              <Table striped withTableBorder fz="xs" style={{ fontVariantNumeric: 'tabular-nums' }}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('monitor.time')}</Table.Th>
                    <Table.Th>CPU, %</Table.Th>
                    <Table.Th>{t('monitor.memChart')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {[...res].reverse().map((r) => (
                    <Table.Tr key={r.t}>
                      <Table.Td>{fmtTime(r.t)}</Table.Td>
                      <Table.Td>{r.cpu.toFixed(1)}</Table.Td>
                      <Table.Td>{r.mem}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
              <Table striped withTableBorder fz="xs" style={{ fontVariantNumeric: 'tabular-nums' }}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('monitor.minute')}</Table.Th>
                    <Table.Th>{t('monitor.requests')}</Table.Th>
                    <Table.Th>{t('monitor.avgMs')}</Table.Th>
                    <Table.Th>{t('monitor.maxMs')}</Table.Th>
                    <Table.Th>5xx</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {[...reqs].reverse().map((r) => (
                    <Table.Tr key={r.t}>
                      <Table.Td>{fmtTime(r.t, false)}</Table.Td>
                      <Table.Td>{r.count}</Table.Td>
                      <Table.Td>{r.avgMs}</Table.Td>
                      <Table.Td>{r.maxMs}</Table.Td>
                      <Table.Td>{r.errors}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </SimpleGrid>
          )}
        </Stack>
      </Card>
    </Stack>
  );
}
