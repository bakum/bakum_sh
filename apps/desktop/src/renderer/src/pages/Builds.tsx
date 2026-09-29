import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { keepPreviousData } from '@tanstack/react-query';
import { Badge, Button, Code, Container, Group, Pagination, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import type { BuildStatus, MethodParams } from '@bm/shared';
import { useBm } from '../lib/query';
import { dayStartIso, fmtDate, fmtDuration, shortSha, TRIGGER_LABELS } from '../lib/format';
import { TestsBadge } from '../components/TestsBadge';

const STATUS_COLOR: Record<BuildStatus, string> = {
  queued: 'gray',
  building: 'orange',
  running: 'teal',
  stopped: 'gray',
  failed: 'red',
  dropped: 'dark',
};

const PAGE = 30;
const FILTERS = ['branch', 'stage', 'status', 'trigger', 'tests', 'from', 'to'] as const;
type Filter = (typeof FILTERS)[number];

/** Builds (spec 8.11): all builds of the project, filtered in Core; filters live in the URL. */
export function BuildsPage() {
  const { pid } = useParams();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const f = (k: Filter) => sp.get(k) || null;
  const page = Number(sp.get('page') ?? 1) || 1;
  const set = (k: Filter | 'page', v: string | null) =>
    setSp(
      (prev) => {
        const n = new URLSearchParams(prev);
        if (v) n.set(k, v);
        else n.delete(k);
        if (k !== 'page') n.delete('page');
        return n;
      },
      { replace: true },
    );

  const branches = useBm('branches.list', { projectId: pid! });
  const branchOptions = [...(branches.data?.production ?? []), ...(branches.data?.development ?? [])].map((b) => ({ value: String(b.id), label: b.name }));
  const params: MethodParams<'builds.list'> = {
    projectId: pid!,
    ...(f('branch') ? { branchId: Number(f('branch')) } : {}),
    ...(f('stage') ? { stage: f('stage') as 'production' | 'development' } : {}),
    ...(f('status') ? { status: f('status') as BuildStatus } : {}),
    ...(f('trigger') ? { trigger: f('trigger') as 'rebuild' } : {}),
    ...(f('tests') ? { tests: f('tests') as 'failed' } : {}),
    ...(f('from') ? { since: dayStartIso(f('from')!) } : {}),
    ...(f('to') ? { until: dayStartIso(f('to')!, 1) } : {}),
    offset: (page - 1) * PAGE,
    limit: PAGE,
  };
  const q = useBm('builds.list', params, { refetchInterval: 5000, placeholderData: keepPreviousData });
  const items = q.data?.items ?? [];
  const total = q.data?.total ?? 0;
  const anyFilter = FILTERS.some((k) => f(k));
  return (
    <Container size="xl" py="md">
      <Stack>
        <Group justify="space-between">
          <Title order={3}>Builds</Title>
          <Text size="sm" c="dimmed">
            {total} {anyFilter ? 'по фильтру' : 'всего'}
          </Text>
        </Group>
        <Group gap="xs" align="flex-end">
          <Select size="xs" w={200} placeholder="Ветка" searchable clearable data={branchOptions} value={f('branch')} onChange={(v) => set('branch', v)} />
          <Select
            size="xs"
            w={140}
            placeholder="Стадия"
            clearable
            data={[
              { value: 'production', label: 'Production' },
              { value: 'development', label: 'Development' },
            ]}
            value={f('stage')}
            onChange={(v) => set('stage', v)}
          />
          <Select size="xs" w={130} placeholder="Статус" clearable data={Object.keys(STATUS_COLOR)} value={f('status')} onChange={(v) => set('status', v)} />
          <Select
            size="xs"
            w={160}
            placeholder="Триггер"
            clearable
            data={Object.entries(TRIGGER_LABELS).map(([value, label]) => ({ value, label }))}
            value={f('trigger')}
            onChange={(v) => set('trigger', v)}
          />
          <Select
            size="xs"
            w={170}
            placeholder="Тесты"
            clearable
            data={[
              { value: 'failed', label: 'Тесты упали' },
              { value: 'passed', label: 'Тесты прошли' },
              { value: 'none', label: 'Тесты не запускались' },
            ]}
            value={f('tests')}
            onChange={(v) => set('tests', v)}
          />
          <TextInput size="xs" type="date" label="С" value={f('from') ?? ''} onChange={(e) => set('from', e.currentTarget.value || null)} />
          <TextInput size="xs" type="date" label="По" value={f('to') ?? ''} onChange={(e) => set('to', e.currentTarget.value || null)} />
          {anyFilter && (
            <Button size="xs" variant="subtle" onClick={() => setSp(new URLSearchParams(), { replace: true })}>
              Сбросить
            </Button>
          )}
        </Group>
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Ветка</Table.Th>
              <Table.Th>#</Table.Th>
              <Table.Th>Стадия</Table.Th>
              <Table.Th>Коммит</Table.Th>
              <Table.Th>Триггер</Table.Th>
              <Table.Th>Статус</Table.Th>
              <Table.Th>Тесты</Table.Th>
              <Table.Th>Длительность</Table.Th>
              <Table.Th>Начало</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {items.map((b) => (
              <Table.Tr key={b.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/projects/${pid}/branches/${b.branchId}/history`)} data-testid={`builds-row-${b.id}`}>
                <Table.Td>{b.branchName}</Table.Td>
                <Table.Td>{b.number}</Table.Td>
                <Table.Td>{b.stage}</Table.Td>
                <Table.Td>
                  <Code>{shortSha(b.commitSha)}</Code> <Text span size="xs" c="dimmed">{b.commits[0]?.message.slice(0, 50)}</Text>
                </Table.Td>
                <Table.Td>{TRIGGER_LABELS[b.trigger] ?? b.trigger}</Table.Td>
                <Table.Td>
                  <Badge color={STATUS_COLOR[b.status]} variant="light">
                    {b.status}
                    {b.isLive ? ' · live' : ''}
                  </Badge>
                </Table.Td>
                <Table.Td onClick={(e) => e.stopPropagation()}>
                  <TestsBadge
                    tests={b.tests}
                    onClick={b.tests ? () => nav(`/projects/${pid}/branches/${b.branchId}/logs?build=${b.id}&source=tests`) : undefined}
                  />
                </Table.Td>
                <Table.Td>{fmtDuration(b.createdAt, b.finishedAt)}</Table.Td>
                <Table.Td>{fmtDate(b.createdAt)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        {q.data && !items.length && (
          <Text size="sm" c="dimmed">
            {anyFilter ? 'Нет сборок по этому фильтру.' : 'Сборок ещё не было.'}
          </Text>
        )}
        {total > PAGE && <Pagination total={Math.ceil(total / PAGE)} value={page} onChange={(p) => set('page', String(p))} size="sm" />}
      </Stack>
    </Container>
  );
}
