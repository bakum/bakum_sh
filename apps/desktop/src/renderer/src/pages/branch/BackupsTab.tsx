import { useState } from 'react';
import { Alert, Badge, Button, Card, Group, Stack, Table, Text, TextInput } from '@mantine/core';
import { IconCamera, IconDatabaseImport, IconFileZip, IconRestore, IconTrash } from '@tabler/icons-react';
import type { BranchView } from '@bm/shared';
import { useBm, useBmMutation } from '../../lib/query';
import { fmtBytes, fmtDate } from '../../lib/format';
import { Spinner } from '../../components/Spinner';
import { t } from '../../i18n';

/** Backups (spec 8.9 / 8.4): for Production — production backups and import; snapshots of the live build. */
export function BackupsTab({ branch }: { branch: BranchView }) {
  const isProd = branch.stage === 'production';
  const list = useBm('backups.list', { projectId: branch.projectId }, { enabled: isProd });
  const imp = useBmMutation('backups.import', { success: t('backups.importQueued') });
  const [over, setOver] = useState(false);

  const doImport = async (path: string) => {
    const r = await window.bm.desktop.confirm({
      message: t('backups.importQ'),
      detail: `${path}\n\n${t('backups.importDetail')}${/\.dump$/i.test(path) ? `\n\n${t('backups.dumpNoFilestore')}` : ''}`,
      buttons: [t('backups.import'), t('common.cancel')],
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
              <Text fw={600}>{t('backups.title')}</Text>
              <Button
                variant="default"
                leftSection={<IconFileZip size={14} />}
                onClick={async () => {
                  const p = await window.bm.desktop.selectFile({ title: t('backups.pickTitle'), extensions: ['zip', 'dump'] });
                  if (p) await doImport(p);
                }}
              >
                {t('backups.pick')}
              </Button>
            </Group>
            <Text size="xs" c="dimmed">
              {t('backups.hint')}
            </Text>
            {!list.data?.length ? (
              <Alert color="gray">{t('backups.empty')}</Alert>
            ) : (
              <Table striped>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('backups.file')}</Table.Th>
                    <Table.Th>{t('backups.size')}</Table.Th>
                    <Table.Th>{t('backups.modified')}</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {list.data.map((f, i) => (
                    <Table.Tr key={f.path}>
                      <Table.Td>
                        {f.name} {i === 0 && <Badge size="xs" ml={4}>{t('backups.new')}</Badge>}
                      </Table.Td>
                      <Table.Td>{fmtBytes(f.sizeBytes)}</Table.Td>
                      <Table.Td>{fmtDate(f.mtime)}</Table.Td>
                      <Table.Td>
                        <Button size="xs" leftSection={<IconDatabaseImport size={12} />} loading={imp.isPending} onClick={() => void doImport(f.path)}>
                          {t('backups.import')}
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

const SNAPSHOT_JOBS = ['snapshot', 'restore_snapshot', 'delete_snapshot', 'export_db'] as const;
const jobText = (type: string): string => t(`snapJob.${type as (typeof SNAPSHOT_JOBS)[number]}`);

/** Snapshots of the live build (spec 8.9): create, roll back, delete, export to an Odoo backup .zip. */
function SnapshotsCard({ branch }: { branch: BranchView }) {
  const live = branch.liveBuild;
  const list = useBm('snapshots.list', { branchId: branch.id }, { refetchInterval: 5000 });
  const jobs = useBm('jobs.list', { projectId: branch.projectId, limit: 30 }, { refetchInterval: 2000 });
  const create = useBmMutation('snapshots.create', { success: t('snaps.creating') });
  const restore = useBmMutation('snapshots.restore', { success: t('snaps.restoreQueued') });
  const del = useBmMutation('snapshots.delete', { success: t('snaps.deleting') });
  const exp = useBmMutation('snapshots.export', { success: t('snaps.exportQueued') });
  const [name, setName] = useState('');
  const mine = (jobs.data ?? []).filter((j) => j.branchId === branch.id && (SNAPSHOT_JOBS as readonly string[]).includes(j.type));
  const active = mine.filter((j) => j.status === 'queued' || j.status === 'running');
  // The latest finished snapshot job, if it failed in the last 10 minutes.
  const lastDone = mine.find((j) => j.status !== 'queued' && j.status !== 'running');
  const lastFailed = lastDone && lastDone.status !== 'success' && Date.now() - new Date(lastDone.finishedAt ?? 0).getTime() < 600_000 ? lastDone : null;

  const doExport = async (snapshotId?: number, label?: string) => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const p = await window.bm.desktop.selectSavePath({
      title: t('snaps.exportTitle'),
      defaultPath: `${branch.slug}-${label ? label.replace(/[^\p{L}\p{N}_-]+/gu, '_') : 'live'}-${stamp}.zip`,
      extensions: ['zip'],
    });
    if (p) exp.mutate({ branchId: branch.id, path: p, ...(snapshotId ? { snapshotId } : {}) });
  };

  if (!live) {
    return (
      <Card withBorder>
        <Text fw={600}>{t('snaps.title')}</Text>
        <Text size="sm" c="dimmed">
          {t('snaps.noLive')}
        </Text>
      </Card>
    );
  }
  return (
    <Card withBorder>
      <Stack>
        <Group justify="space-between">
          <Text fw={600}>{t('snaps.titleDb', { db: live.dbName })}</Text>
          <Group gap="xs">
            <TextInput size="xs" w={240} placeholder={t('snaps.name')} value={name} onChange={(e) => setName(e.currentTarget.value)} />
            <Button
              size="xs"
              leftSection={<IconCamera size={14} />}
              loading={create.isPending}
              disabled={active.length > 0}
              onClick={() => create.mutate({ branchId: branch.id, ...(name.trim() ? { name: name.trim() } : {}) }, { onSuccess: () => setName('') })}
              data-testid="snapshot-create"
            >
              {t('snaps.create')}
            </Button>
            <Button size="xs" variant="default" leftSection={<IconFileZip size={14} />} onClick={() => void doExport()}>
              {t('snaps.export')}
            </Button>
          </Group>
        </Group>
        <Text size="xs" c="dimmed">
          {t('snaps.hint')}
        </Text>
        {active.map((j) => (
          <Alert key={j.id} color="orange" variant="light" icon={<Spinner size={14} />} p="xs">
            {jobText(j.type)}…{j.status === 'queued' ? t('snaps.queued') : ''}
          </Alert>
        ))}
        {!active.length && lastFailed && (
          <Alert color="red" variant="light" p="xs" title={t('snaps.failed', { job: jobText(lastFailed.type) })}>
            <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
              {lastFailed.error ?? lastFailed.status}
            </Text>
          </Alert>
        )}
        {!list.data?.length ? (
          <Text size="sm" c="dimmed">
            {t('snaps.none')}
          </Text>
        ) : (
          <Table striped data-testid="snapshots">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('snaps.colName')}</Table.Th>
                <Table.Th>{t('snaps.colDb')}</Table.Th>
                <Table.Th>{t('backups.size')}</Table.Th>
                <Table.Th>{t('snaps.colCreated')}</Table.Th>
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
                            message: t('snaps.restoreQ', { db: live.dbName, name: s.name }),
                            detail: t('snaps.restoreDetail'),
                            buttons: [t('snaps.restore'), t('common.cancel')],
                          });
                          if (r === 0) restore.mutate({ snapshotId: s.id });
                        }}
                      >
                        {t('snaps.restore')}
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
                          const r = await window.bm.desktop.confirm({ message: t('snaps.deleteQ', { name: s.name }), detail: t('snaps.deleteDetail', { db: s.dbName }), buttons: [t('common.delete'), t('common.cancel')] });
                          if (r === 0) del.mutate({ snapshotId: s.id });
                        }}
                      >
                        {t('common.delete')}
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
