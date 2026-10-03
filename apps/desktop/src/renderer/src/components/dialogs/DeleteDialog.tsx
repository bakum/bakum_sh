import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Checkbox, Code, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import type { BranchView } from '@bm/shared';
import { useBm, useBmMutation } from '../../lib/query';
import { t } from '../../i18n';

/** Delete (spec 8.10): confirmation by typing the slug; a dirty worktree needs a separate confirmation. */
export function DeleteDialog({ open, branch, onClose }: { open: boolean; branch: BranchView; onClose: () => void }) {
  const nav = useNavigate();
  const [slug, setSlug] = useState('');
  const [forceDirty, setForceDirty] = useState(false);
  const preview = useBm('branches.deletePreview', { branchId: branch.id }, { enabled: open });
  const del = useBmMutation('branches.delete', { success: t('delBranch.deleting') });
  useEffect(() => {
    if (open) {
      setSlug('');
      setForceDirty(false);
    }
  }, [open]);
  const p = preview.data;
  return (
    <Modal opened={open} onClose={onClose} title={t('delBranch.title', { branch: branch.name })} size="lg">
      <Stack>
        {p?.protected ? (
          <Alert color="orange">{t('delBranch.protected')}</Alert>
        ) : p?.folderBlocked ? (
          <Alert color="red" data-testid="delete-folder-blocked">
            {p.folderBlocked}
          </Alert>
        ) : (
          <>
            <Text size="sm">
              {t('delBranch.what', { n: p?.builds ?? '…' })}
            </Text>
            {p?.dirty && (
              <Alert color="red" title={t('delBranch.dirty')}>
                <Code block>{p.dirty}</Code>
                <Checkbox mt="xs" label={t('delBranch.dirtyOk')} checked={forceDirty} onChange={(e) => setForceDirty(e.currentTarget.checked)} />
              </Alert>
            )}
            <TextInput label={t('delBranch.typeSlug', { slug: branch.slug })} value={slug} onChange={(e) => setSlug(e.currentTarget.value)} />
          </>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            color="red"
            disabled={!!p?.protected || !!p?.folderBlocked || slug !== branch.slug || (!!p?.dirty && !forceDirty)}
            loading={del.isPending}
            onClick={() =>
              del.mutate(
                { branchId: branch.id, confirmSlug: slug, deleteRemote: false, forceDirty },
                {
                  onSuccess: () => {
                    onClose();
                    nav(`/projects/${branch.projectId}/branches`);
                  },
                },
              )
            }
          >
            {t('common.delete')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
