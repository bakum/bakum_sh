import { useState } from 'react';
import { Alert, Badge, Button, Card, Group, Stack, Table, Text, TextInput } from '@mantine/core';
import { IconCamera, IconDatabaseImport, IconFileZip, IconRestore, IconTrash } from '@tabler/icons-react';
import type { BranchView } from '@bm/shared';
import { useBm, useBmMutation } from '../../lib/query';
import { fmtBytes, fmtDate } from '../../lib/format';
import { Spinner } from '../../components/Spinner';

/** Backups (spec 8.9 / 8.4): for Production — production backups and import; snapshots of the live build. */
export function BackupsTab({ branch }: { branch: BranchView }) {
  const isProd = branch.stage === 'production';
  const list = useBm('backups.list', { projectId: branch.projectId }, { enabled: isProd });
  const imp = useBmMutation('backups.import', { success: 'Импорт бэкапа поставлен в очередь' });
  const [over, setOver] = useState(false);

  const doImport = async (path: string) => {
    const r = await window.bm.desktop.confirm({
      message: 'Импортировать бэкап прода?',
      detail: `${path}\n\nБудет собрано новое зеркало прода: восстановление, нейтрализация, postRestore SQL, обновление модулей. Текущее зеркало продолжит работать до успешного завершения. Ветки Development не затрагиваются.${/\.dump$/i.test(path) ? '\n\nВ .dump нет filestore: вложения и картинки прода в сборке не откроются.' : ''}`,
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
                  const p = await window.bm.desktop.selectFile({ title: 'Бэкап прода (.zip или .dump)', extensions: ['zip', 'dump'] });
                  if (p) await doImport(p);
                }}
              >
                Выбрать файл…
              </Button>
            </Group>
            <Text size="xs" c="dimmed">
              Файл монтируется в одноразовый контейнер только для чтения и не копируется. Можно перетащить файл в эту область. Бэкап Odoo
              .zip содержит БД и filestore; дамп .dump (pg_dump -Fc) — только БД, вложения прода в сборке не откроются.
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
      <SnapshotsCard branch={branch} />
    </Stack>
  );
}

const JOB_TEXT: Record<string, string> = {
  snapshot: 'Создание снапшота',
  restore_snapshot: 'Откат к снапшоту',
  delete_snapshot: 'Удаление снапшота',
  export_db: 'Выгрузка в .zip',
};

/** Snapshots of the live build (spec 8.9): create, roll back, delete, export to an Odoo backup .zip. */
function SnapshotsCard({ branch }: { branch: BranchView }) {
  const live = branch.liveBuild;
  const list = useBm('snapshots.list', { branchId: branch.id }, { refetchInterval: 5000 });
  const jobs = useBm('jobs.list', { projectId: branch.projectId, limit: 30 }, { refetchInterval: 2000 });
  const create = useBmMutation('snapshots.create', { success: 'Снапшот создаётся' });
  const restore = useBmMutation('snapshots.restore', { success: 'Откат поставлен в очередь' });
  const del = useBmMutation('snapshots.delete', { success: 'Снапшот удаляется' });
  const exp = useBmMutation('snapshots.export', { success: 'Выгрузка поставлена в очередь' });
  const [name, setName] = useState('');
  const mine = (jobs.data ?? []).filter((j) => j.branchId === branch.id && j.type in JOB_TEXT);
  const active = mine.filter((j) => j.status === 'queued' || j.status === 'running');
  // The latest finished snapshot job, if it failed in the last 10 minutes.
  const lastDone = mine.find((j) => j.status !== 'queued' && j.status !== 'running');
  const lastFailed = lastDone && lastDone.status !== 'success' && Date.now() - new Date(lastDone.finishedAt ?? 0).getTime() < 600_000 ? lastDone : null;

  const doExport = async (snapshotId?: number, label?: string) => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const p = await window.bm.desktop.selectSavePath({
      title: 'Выгрузить в бэкап Odoo (.zip)',
      defaultPath: `${branch.slug}-${label ? label.replace(/[^\p{L}\p{N}_-]+/gu, '_') : 'live'}-${stamp}.zip`,
      extensions: ['zip'],
    });
    if (p) exp.mutate({ branchId: branch.id, path: p, ...(snapshotId ? { snapshotId } : {}) });
  };

  if (!live) {
    return (
      <Card withBorder>
        <Text fw={600}>Снапшоты</Text>
        <Text size="sm" c="dimmed">
          Снапшоты делаются с БД живой сборки, а её у ветки нет. Нажмите Rebuild.
        </Text>
      </Card>
    );
  }
  return (
    <Card withBorder>
      <Stack>
        <Group justify="space-between">
          <Text fw={600}>Снапшоты БД {live.dbName}</Text>
          <Group gap="xs">
            <TextInput size="xs" w={240} placeholder="Название (необязательно)" value={name} onChange={(e) => setName(e.currentTarget.value)} />
            <Button
              size="xs"
              leftSection={<IconCamera size={14} />}
              loading={create.isPending}
              disabled={active.length > 0}
              onClick={() => create.mutate({ branchId: branch.id, ...(name.trim() ? { name: name.trim() } : {}) }, { onSuccess: () => setName('') })}
              data-testid="snapshot-create"
            >
              Создать снапшот
            </Button>
            <Button size="xs" variant="default" leftSection={<IconFileZip size={14} />} onClick={() => void doExport()}>
              Выгрузить БД в .zip
            </Button>
          </Group>
        </Group>
        <Text size="xs" c="dimmed">
          Снапшот — копия БД и filestore этой сборки. Контейнер сборки останавливается на время копирования (обычно секунды). Откат
          заменяет БД снапшотом, а текущее состояние сохраняет новым снапшотом «Перед откатом». Выгрузка — бэкап Odoo .zip (БД +
          filestore), его можно импортировать в Production или восстановить в любой Odoo.
        </Text>
        {active.map((j) => (
          <Alert key={j.id} color="orange" variant="light" icon={<Spinner size={14} />} p="xs">
            {JOB_TEXT[j.type]}…{j.status === 'queued' ? ' (в очереди)' : ''}
          </Alert>
        ))}
        {!active.length && lastFailed && (
          <Alert color="red" variant="light" p="xs" title={`${JOB_TEXT[lastFailed.type]}: ошибка`}>
            <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
              {lastFailed.error ?? lastFailed.status}
            </Text>
          </Alert>
        )}
        {!list.data?.length ? (
          <Text size="sm" c="dimmed">
            Снапшотов нет.
          </Text>
        ) : (
          <Table striped data-testid="snapshots">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Название</Table.Th>
                <Table.Th>БД</Table.Th>
                <Table.Th>Размер</Table.Th>
                <Table.Th>Создан</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.data.map((s) => (
                <Table.Tr key={s.id} data-testid={`snapshot-${s.id}`}>
                  <Table.Td>{s.name}</Table.Td>
                  <Table.Td>
                    <Text size="xs" ff="monospace">
                      {s.dbName}
                    </Text>
                  </Table.Td>
                  <Table.Td>{fmtBytes(s.sizeBytes)}</Table.Td>
                  <Table.Td>{fmtDate(s.createdAt)}</Table.Td>
                  <Table.Td>
                    <Group gap={4} justify="flex-end" wrap="nowrap">
                      <Button
                        size="compact-xs"
                        variant="light"
                        leftSection={<IconRestore size={12} />}
                        disabled={active.length > 0}
                        onClick={async () => {
                          const r = await window.bm.desktop.confirm({
                            message: `Откатить БД ${live.dbName} к снапшоту «${s.name}»?`,
                            detail: 'Контейнер сборки будет остановлен, БД и filestore заменены снапшотом. Текущее состояние сохранится новым снапшотом «Перед откатом».',
                            buttons: ['Откатить', 'Отмена'],
                          });
                          if (r === 0) restore.mutate({ snapshotId: s.id });
                        }}
                      >
                        Откатить
                      </Button>
                      <Button size="compact-xs" variant="default" leftSection={<IconFileZip size={12} />} onClick={() => void doExport(s.id, s.name)}>
                        .zip
                      </Button>
                      <Button
                        size="compact-xs"
                        color="red"
                        variant="subtle"
                        leftSection={<IconTrash size={12} />}
                        disabled={active.length > 0}
                        onClick={async () => {
                          const r = await window.bm.desktop.confirm({ message: `Удалить снапшот «${s.name}»?`, detail: `БД ${s.dbName} и её filestore будут удалены.`, buttons: ['Удалить', 'Отмена'] });
                          if (r === 0) del.mutate({ snapshotId: s.id });
                        }}
                      >
                        Удалить
                      </Button>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Stack>
    </Card>
  );
}
