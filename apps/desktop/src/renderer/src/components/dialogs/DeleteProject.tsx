import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Code, Group, List, Modal, Stack, Text, TextInput } from '@mantine/core';
import { useBm, useBmMutation } from '../../lib/query';
import { t, tx } from '../../i18n';

/** Project removal (spec 8.1, full cleanup D34): lists every resource, confirmation by typing the id; the user's repository stays. */
export function DeleteProjectButton({ projectId }: { projectId: string }) {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const pv = useBm('projects.deletePreview', { projectId }, { enabled: open });
  const del = useBmMutation('projects.delete', { success: t('delProject.deleting') });
  const section = (title: string, items: string[] | undefined) => (
    <Stack gap={2}>
      <Text size="sm" fw={600}>
        {title}: {items?.length ?? '…'}
      </Text>
      {!!items?.length && (
        <List size="xs" spacing={0}>
          {items.slice(0, 20).map((x) => (
            <List.Item key={x}>
              <Code>{x}</Code>
            </List.Item>
          ))}
        </List>
      )}
    </Stack>
  );
  return (
    <>
      <Button color="red" variant="light" onClick={() => setOpen(true)}>
        {t('delProject.button')}
      </Button>
      <Modal opened={open} onClose={() => setOpen(false)} title={t('delProject.title', { id: projectId })} size="lg">
        <Stack>
          <Alert color="red">
            {t('delProject.what')}
          </Alert>
          {section(t('delProject.builds'), pv.data?.builds)}
          {section(t('delProject.databases'), pv.data?.databases)}
          {section('filestore', pv.data?.filestores)}
          {section(t('delProject.worktrees'), pv.data?.worktrees)}
          {section(t('delProject.folders'), pv.data?.folders)}
          {pv.data?.postgres && (
            <Text size="sm">
              {tx('delProject.postgres', { pg: pv.data.postgres }, { b: (x) => <b>{x}</b> })}
            </Text>
          )}
          {pv.data?.image && (
            <Text size="sm">
              {tx('delProject.image', { image: pv.data.image }, { b: (x) => <b>{x}</b> })}
            </Text>
          )}
          {pv.data && (
            <Text size="sm">
              {tx(
                'delProject.settings',
                { file: pv.data.settingsFile, jobs: pv.data.registry.jobs, audit: pv.data.registry.audit, kv: pv.data.registry.kv },
                { b: (x) => <b>{x}</b>, code: (x) => <Code>{x}</Code> },
              )}
            </Text>
          )}
          {pv.data?.legacy && (
            <Text size="sm" c="dimmed">
              {t('delProject.legacy')}
            </Text>
          )}
          <TextInput label={t('delProject.typeId', { id: projectId })} value={confirm} onChange={(e) => setConfirm(e.currentTarget.value)} />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              color="red"
              disabled={confirm !== projectId}
              loading={del.isPending}
              onClick={() => del.mutate({ projectId, confirm }, { onSuccess: () => { setOpen(false); nav('/'); } })}
            >
              {t('delProject.confirm')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
