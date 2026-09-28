import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Checkbox, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import type { BranchView } from '@bm/shared';
import { useBm, useBmMutation } from '../../lib/query';

/** Fork (spec 8.10): new branch from the live build commit (or HEAD) → Development → build. No push in stage 1. */
export function ForkDialog({ open, branch, onClose }: { open: boolean; branch: BranchView; onClose: () => void }) {
  const nav = useNavigate();
  const [name, setName] = useState('');
  useEffect(() => {
    if (open) setName('');
  }, [open]);
  const preview = useBm('branches.forkName', { projectId: branch.projectId, name }, { enabled: open && !!name });
  const fork = useBmMutation('branches.fork', { success: 'Ветка создана, сборка поставлена в очередь' });
  const from = branch.liveBuild?.commitSha ? `коммита живой сборки ${branch.liveBuild.commitSha.slice(0, 7)}` : `HEAD ${branch.name}`;
  return (
    <Modal opened={open} onClose={onClose} title={`Fork от ${branch.name}`}>
      <Stack>
        <TextInput label="Имя новой ветки" placeholder="test999" value={name} onChange={(e) => setName(e.currentTarget.value)} data-autofocus />
        {preview.data && (
          <Text size="sm">
            Будет создана ветка <b>{preview.data.name}</b> от {from}
          </Text>
        )}
        {preview.data?.error && <Alert color="red">{preview.data.error}</Alert>}
        <Checkbox label="Push -u origin (этап 2)" disabled />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Отмена
          </Button>
          <Button
            disabled={!preview.data?.valid}
            loading={fork.isPending}
            onClick={() =>
              fork.mutate(
                { branchId: branch.id, name: preview.data!.name, push: false },
                {
                  onSuccess: (r) => {
                    onClose();
                    nav(`/projects/${branch.projectId}/branches/${r.branch.id}`);
                  },
                },
              )
            }
          >
            Создать ветку
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
