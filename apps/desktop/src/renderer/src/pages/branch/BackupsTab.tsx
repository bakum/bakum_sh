import { useState } from 'react';
import { Alert, Badge, Box, Button, Card, Group, Stack, Table, Text } from '@mantine/core';
import { IconDatabaseImport, IconFileZip } from '@tabler/icons-react';
import type { BranchView } from '@bm/shared';
import { useBm, useBmMutation } from '../../lib/query';
import { fmtBytes, fmtDate } from '../../lib/format';
import { Stage2 } from '../../components/Stage2';

/** Backups (spec 8.9 / 8.4): for Production — production backups and import; snapshots are stage 2. */
export function BackupsTab({ branch }: { branch: BranchView }) {
  const isProd = branch.stage === 'production';
  const list = useBm('backups.list', { projectId: branch.projectId }, { enabled: isProd });
  const imp = useBmMutation('backups.import', { success: 'Импорт бэкапа поставлен в очередь' });
  const [over, setOver] = useState(false);

  const doImport = async (path: string) => {
    const r = await window.bm.desktop.confirm({
      message: 'Импортировать бэкап прода?',
      detail: `${path}\n\nБудет собрано новое зеркало прода: восстановление, нейтрализация, postRestore SQL, обновление модулей. Текущее зеркало продолжит работать до успешного завершения. Staging и Development не затрагиваются.`,
      buttons: ['Импортировать', 'Отмена'],
    });
    if (r === 0) imp.mutate({ projectId: branch.projectId, path });
  };

  return (
    <Stack>
      {isProd && (
        <Card
          withBorder
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const f = e.dataTransfer.files[0];
            if (f) void doImport(window.bm.desktop.pathForFile(f));
          }}
          style={over ? { outline: '2px dashed var(--mantine-color-teal-6)' } : undefined}
        >
          <Stack>
            <Group justify="space-between">
              <Text fw={600}>Бэкапы прода</Text>
              <Button
                variant="default"
                leftSection={<IconFileZip size={14} />}
                onClick={async () => {
                  const p = await window.bm.desktop.selectFile({ title: 'Бэкап прода (.zip)', extensions: ['zip'] });
                  if (p) await doImport(p);
                }}
              >
                Выбрать файл…
              </Button>
            </Group>
            <Text size="xs" c="dimmed">
              Файл монтируется в одноразовый контейнер только для чтения и не копируется. Можно перетащить .zip в эту область.
            </Text>
            {!list.data?.length ? (
              <Alert color="gray">В папке бэкапов нет файлов по шаблону. Проверьте Settings → Данные (Production).</Alert>
            ) : (
              <Table striped>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Файл</Table.Th>
                    <Table.Th>Размер</Table.Th>
                    <Table.Th>Изменён</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {list.data.map((f, i) => (
                    <Table.Tr key={f.path}>
                      <Table.Td>
                        {f.name} {i === 0 && <Badge size="xs" ml={4}>новый</Badge>}
                      </Table.Td>
                      <Table.Td>{fmtBytes(f.sizeBytes)}</Table.Td>
                      <Table.Td>{fmtDate(f.mtime)}</Table.Td>
                      <Table.Td>
                        <Button size="xs" leftSection={<IconDatabaseImport size={12} />} loading={imp.isPending} onClick={() => void doImport(f.path)}>
                          Импортировать
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </Stack>
        </Card>
      )}
      <Box>
        <Stage2 what="Снапшоты живой сборки: создать, откатить, удалить, выгрузить в .zip" />
      </Box>
    </Stack>
  );
}
