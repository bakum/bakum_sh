import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Badge, Code, Container, Group, Pagination, Select, Stack, Table, Text, Title } from '@mantine/core';
import type { BuildStatus } from '@bm/shared';
import { useBm } from '../lib/query';
import { fmtDate, fmtDuration, shortSha } from '../lib/format';

const STATUS_COLOR: Record<BuildStatus, string> = {
  queued: 'gray',
  building: 'orange',
  running: 'teal',
  stopped: 'gray',
  failed: 'red',
  dropped: 'dark',
};

const PAGE = 30;

/** Builds (spec 8.11): all builds of the project with filters. */
export function BuildsPage() {
  const { pid } = useParams();
  const nav = useNavigate();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<string | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const q = useBm('builds.list', { projectId: pid!, offset: (page - 1) * PAGE, limit: 200 }, { refetchInterval: 5000 });
  const items = (q.data?.items ?? []).filter((b) => (!status || b.status === status) && (!stage || b.stage === stage));
  const shown = items.slice((page - 1) * PAGE, page * PAGE);
  return (
    <Container size="xl" py="md">
      <Stack>
        <Group justify="space-between">
          <Title order={3}>Builds</Title>
          <Group>
            <Select size="xs" placeholder="Стадия" clearable data={['production', 'staging', 'development']} value={stage} onChange={setStage} />
            <Select size="xs" placeholder="Статус" clearable data={['queued', 'building', 'running', 'stopped', 'failed', 'dropped']} value={status} onChange={setStatus} />
          </Group>
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
            {shown.map((b) => (
              <Table.Tr key={b.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/projects/${pid}/branches/${b.branchId}/history`)}>
                <Table.Td>{b.branchName}</Table.Td>
                <Table.Td>{b.number}</Table.Td>
                <Table.Td>{b.stage}</Table.Td>
                <Table.Td>
                  <Code>{shortSha(b.commitSha)}</Code> <Text span size="xs" c="dimmed">{b.commits[0]?.message.slice(0, 50)}</Text>
                </Table.Td>
                <Table.Td>{b.trigger}</Table.Td>
                <Table.Td>
                  <Badge color={STATUS_COLOR[b.status]} variant="light">
                    {b.status}
                    {b.isLive ? ' · live' : ''}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed">
                    этап 2
                  </Text>
                </Table.Td>
                <Table.Td>{fmtDuration(b.createdAt, b.finishedAt)}</Table.Td>
                <Table.Td>{fmtDate(b.createdAt)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        {items.length > PAGE && <Pagination total={Math.ceil(items.length / PAGE)} value={page} onChange={setPage} size="sm" />}
      </Stack>
    </Container>
  );
}
