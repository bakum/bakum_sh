import { useState } from 'react';
import { Alert, Button, Card, Group, Paper, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import { keepPreviousData } from '@tanstack/react-query';
import type { BranchView } from '@bm/shared';
import { useBm } from '../../lib/query';
import { fmtAgo, fmtBytes, fmtDate } from '../../lib/format';
import { MinuteBars, TimeLineChart } from '../../components/MonitorCharts';

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
  if (!live) return <Alert color="gray">У ветки нет живой сборки: мониторить нечего. Нажмите Rebuild.</Alert>;
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
        <Tile label="CPU сейчас" value={last ? `${last.cpu.toFixed(1)} %` : m.running ? '—' : 'остановлена'} hint="100 % — одно ядро" />
        <Tile label="Память сейчас" value={last ? `${last.mem} МБ` : '—'} hint={m.memLimitMb ? `из ${m.memLimitMb} МБ доступных Docker` : undefined} />
        <Tile label="Запросов за час" value={String(total)} hint={avg !== null ? `в среднем ${avg} мс${errors ? `, ошибок 5xx: ${errors}` : ''}` : 'через Traefik'} />
        <Tile label="Последний заход" value={m.lastActiveAt ? fmtAgo(m.lastActiveAt) : '—'} hint={m.lastActiveAt ? fmtDate(m.lastActiveAt) : 'запросов к сборке ещё не было'} />
        <Tile label="Размер БД" value={fmtBytes(m.dbSizeBytes)} />
        <Tile label="Filestore" value={fmtBytes(m.filestoreBytes)} hint="вложения; хардлинки считаются полностью" />
        <Tile
          label="Остановка без активности"
          value={m.idleStopAt ? fmtDate(m.idleStopAt) : m.idleStopHours ? 'не работает сейчас' : 'выключена'}
          hint={m.idleStopHours ? `idleStopHours: ${m.idleStopHours} ч с последнего захода или запуска` : 'idleStopHours: 0'}
        />
        <Tile
          label="Срок хранения"
          value={m.expiresAt ? fmtDate(m.expiresAt) : 'без срока'}
          hint={m.dropAfterDays ? `dropAfterDays: ${m.dropAfterDays} дн.; потом — напоминание, отбросить вручную` : 'dropAfterDays: 0'}
        />
      </SimpleGrid>
      <Card withBorder>
        <Stack gap="lg">
          <TimeLineChart title="CPU, % одного ядра" points={res.map((r) => ({ t: r.t, v: r.cpu }))} format={(v) => `${Math.round(v)} %`} from={from} to={to} />
          <TimeLineChart
            title="Память, МБ"
            points={res.map((r) => ({ t: r.t, v: r.mem }))}
            format={(v) => `${Math.round(v)}`}
            from={from}
            to={to}
          />
          <MinuteBars
            title="Запросы в минуту (без фоновых websocket / longpolling)"
            bars={reqs.map((r) => ({ t: r.t, v: r.count }))}
            from={from}
            to={to}
            detail={(t) => {
              const r = byMinute.get(t);
              return `${new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}: среднее ${r?.avgMs ?? 0} мс, макс. ${r?.maxMs ?? 0} мс${r?.errors ? `, 5xx: ${r.errors}` : ''}`;
            }}
          />
          <Group>
            <Button size="xs" variant="subtle" onClick={() => setTable((v) => !v)}>
              {table ? 'Скрыть таблицу' : 'Показать таблицу значений'}
            </Button>
            <Text size="xs" c="dimmed">
              CPU и память замеряются раз в 30 с, пока приложение запущено; после перезапуска история начинается заново.
            </Text>
          </Group>
          {table && (
            <SimpleGrid cols={{ base: 1, md: 2 }}>
              <Table striped withTableBorder fz="xs" style={{ fontVariantNumeric: 'tabular-nums' }}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Время</Table.Th>
                    <Table.Th>CPU, %</Table.Th>
                    <Table.Th>Память, МБ</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {[...res].reverse().map((r) => (
                    <Table.Tr key={r.t}>
                      <Table.Td>{new Date(r.t).toLocaleTimeString('ru-RU')}</Table.Td>
                      <Table.Td>{r.cpu.toFixed(1)}</Table.Td>
                      <Table.Td>{r.mem}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
              <Table striped withTableBorder fz="xs" style={{ fontVariantNumeric: 'tabular-nums' }}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Минута</Table.Th>
                    <Table.Th>Запросов</Table.Th>
                    <Table.Th>Среднее, мс</Table.Th>
                    <Table.Th>Макс., мс</Table.Th>
                    <Table.Th>5xx</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {[...reqs].reverse().map((r) => (
                    <Table.Tr key={r.t}>
                      <Table.Td>{new Date(r.t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</Table.Td>
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
