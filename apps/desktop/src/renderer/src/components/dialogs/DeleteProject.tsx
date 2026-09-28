import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Code, Group, List, Modal, Stack, Text, TextInput } from '@mantine/core';
import { useBm, useBmMutation } from '../../lib/query';

/** Project removal (spec 8.1, full cleanup D34): lists every resource, confirmation by typing the id; the user's repository stays. */
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
            Проект удаляется полностью: сборки (контейнеры, БД, filestore), папки веток, копия репозитория приложения, compose-файлы, логи, файл
            настроек и записи в реестре. Ваш репозиторий, его ветки и ветки на GitHub не затрагиваются.
          </Alert>
          {section('Сборки', pv.data?.builds)}
          {section('Базы данных', pv.data?.databases)}
          {section('filestore', pv.data?.filestores)}
          {section('Папки веток (worktree)', pv.data?.worktrees)}
          {section('Папки приложения (копия репозитория, compose-файлы, логи сборок)', pv.data?.folders)}
          {pv.data?.postgres && (
            <Text size="sm">
              <b>Postgres проекта:</b> {pv.data.postgres} — удаляются вместе со всеми базами.
            </Text>
          )}
          {pv.data && (
            <Text size="sm">
              <b>Файл настроек:</b> <Code>{pv.data.settingsFile}</Code> — удаляется без копии. <b>Реестр:</b> задач {pv.data.registry.jobs} (с логами),
              записей аудита {pv.data.registry.audit}, исключений автодобавления {pv.data.registry.kv}. В Audit Logs останется одна запись об удалении.
            </Text>
          )}
          {pv.data?.legacy && (
            <Text size="sm" c="dimmed">
              Проект старой схемы: папки веток удаляются из вашего репозитория командой git worktree remove, больше в нём ничего не меняется.
            </Text>
          )}
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
