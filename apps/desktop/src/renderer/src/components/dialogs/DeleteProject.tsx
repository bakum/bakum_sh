import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Code, Group, List, Modal, Stack, Text, TextInput } from '@mantine/core';
import { useBm, useBmMutation } from '../../lib/query';

/** Project removal (spec 8.1): lists every resource, confirmation by typing the id; the git repository stays. */
export function DeleteProjectButton({ projectId }: { projectId: string }) {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const pv = useBm('projects.deletePreview', { projectId }, { enabled: open });
  const del = useBmMutation('projects.delete', { success: 'Проект удаляется' });
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
        Удалить проект…
      </Button>
      <Modal opened={open} onClose={() => setOpen(false)} title={`Удалить проект ${projectId}`} size="lg">
        <Stack>
          <Alert color="red">
            Будут удалены все сборки проекта: контейнеры, БД, filestore, worktree. Git-репозиторий и его ветки не затрагиваются.
          </Alert>
          {section('Сборки', pv.data?.builds)}
          {section('Базы данных', pv.data?.databases)}
          {section('filestore', pv.data?.filestores)}
          {section('worktree', pv.data?.worktrees)}
          <TextInput label={`Введите id проекта: ${projectId}`} value={confirm} onChange={(e) => setConfirm(e.currentTarget.value)} />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setOpen(false)}>
              Отмена
            </Button>
            <Button
              color="red"
              disabled={confirm !== projectId}
              loading={del.isPending}
              onClick={() => del.mutate({ projectId, confirm }, { onSuccess: () => { setOpen(false); nav('/'); } })}
            >
              Удалить проект
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
