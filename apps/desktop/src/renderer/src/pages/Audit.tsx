import { useParams } from 'react-router-dom';
import { Badge, Container, Stack, Table, Text, Title } from '@mantine/core';
import { useBm } from '../lib/query';
import { fmtDate } from '../lib/format';

/** Audit Logs (spec 8.11): actions of the app and the user. The full view with YAML diffs is stage 2. */
export function AuditPage() {
  const { pid } = useParams();
  const q = useBm('audit.list', { projectId: pid, limit: 300 }, { refetchInterval: 10000 });
  return (
    <Container size="xl" py="md">
      <Stack>
        <Title order={3}>Audit Logs</Title>
        <Text size="sm" c="dimmed">
          Все действия приложения и пользователя по проекту. Просмотр diff настроек и фильтры — этап 2.
        </Text>
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={160}>Когда</Table.Th>
              <Table.Th w={220}>Действие</Table.Th>
              <Table.Th>Объект</Table.Th>
              <Table.Th w={90}>Итог</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(q.data ?? []).map((a) => (
              <Table.Tr key={a.id}>
                <Table.Td>{fmtDate(a.at)}</Table.Td>
                <Table.Td>{a.action}</Table.Td>
                <Table.Td>{a.target}</Table.Td>
                <Table.Td>
                  <Badge color={a.result === 'ok' ? 'teal' : 'red'} variant="light">
                    {a.result}
                  </Badge>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Stack>
    </Container>
  );
}
