import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Checkbox, Code, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import type { BranchView } from '@bm/shared';
import { useBm, useBmMutation } from '../../lib/query';

/** Delete (spec 8.10): confirmation by typing the slug; a dirty worktree needs a separate confirmation. */
export function DeleteDialog({ open, branch, onClose }: { open: boolean; branch: BranchView; onClose: () => void }) {
  const nav = useNavigate();
  const [slug, setSlug] = useState('');
  const [deleteLocal, setDeleteLocal] = useState(false);
  const [forceDirty, setForceDirty] = useState(false);
  const preview = useBm('branches.deletePreview', { branchId: branch.id }, { enabled: open });
  const del = useBmMutation('branches.delete', { success: 'Ветка удаляется' });
  useEffect(() => {
    if (open) {
      setSlug('');
      setDeleteLocal(false);
      setForceDirty(false);
    }
  }, [open]);
  const p = preview.data;
  return (
    <Modal opened={open} onClose={onClose} title={`Удалить ветку ${branch.name}`} size="lg">
      <Stack>
        {p?.protected ? (
          <Alert color="orange">Ветка защищена (protected). Снимите защиту в Settings ветки, чтобы удалить её.</Alert>
        ) : (
          <>
            <Text size="sm">
              Будут отброшены все сборки ветки ({p?.builds ?? '…'}): БД, filestore и контейнеры. Worktree будет удалён. История остаётся в Audit
              Logs. Ветка в git сохраняется, если не отмечено иное.
            </Text>
            {p?.dirty && (
              <Alert color="red" title="В worktree есть незакоммиченные изменения">
                <Code block>{p.dirty}</Code>
                <Checkbox mt="xs" label="Я понимаю, что эти изменения будут потеряны" checked={forceDirty} onChange={(e) => setForceDirty(e.currentTarget.checked)} />
              </Alert>
            )}
            <Checkbox label="Удалить локальную ветку (git branch -d, только слитую)" checked={deleteLocal} onChange={(e) => setDeleteLocal(e.currentTarget.checked)} />
            <Checkbox label="Удалить ветку в origin (этап 2)" disabled />
            <TextInput label={`Для подтверждения введите slug: ${branch.slug}`} value={slug} onChange={(e) => setSlug(e.currentTarget.value)} />
          </>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Отмена
          </Button>
          <Button
            color="red"
            disabled={!!p?.protected || slug !== branch.slug || (!!p?.dirty && !forceDirty)}
            loading={del.isPending}
            onClick={() =>
              del.mutate(
                { branchId: branch.id, confirmSlug: slug, deleteLocal, deleteRemote: false, forceDirty },
                {
                  onSuccess: () => {
                    onClose();
                    nav(`/projects/${branch.projectId}/branches`);
                  },
                },
              )
            }
          >
            Удалить
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
