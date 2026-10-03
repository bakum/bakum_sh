import { useEffect, useState } from 'react';
import { Alert, Button, Group, Modal, Select, Stack, Text } from '@mantine/core';
import type { BranchView } from '@bm/shared';
import { useBmMutation } from '../../lib/query';
import { t } from '../../i18n';

/**
 * Merge (spec 8.10): PR head=<source> → base=<target>. Creating the PR through `gh` is postponed (D44):
 * the GitHub compare page opens in the browser. No local merge, no push.
 */
export function MergeDialog({ value, branches, onClose }: { value: { source: BranchView; target: BranchView | null } | null; branches: BranchView[]; onClose: () => void }) {
  const [target, setTarget] = useState<string | null>(null);
  const merge = useBmMutation('branches.merge');
  useEffect(() => setTarget(value?.target ? String(value.target.id) : null), [value]);
  if (!value) return null;
  const options = branches.filter((b) => b.id !== value.source.id).map((b) => ({ value: String(b.id), label: `${b.name} (${b.stage})` }));
  return (
    <Modal opened onClose={onClose} title={`Merge: ${value.source.name}`}>
      <Stack>
        <Select label={t('merge.into')} data={options} value={target} onChange={setTarget} searchable />
        <Alert color="gray" variant="light">
          {t('merge.hint')}
        </Alert>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={!target}
            loading={merge.isPending}
            onClick={() =>
              merge.mutate(
                { sourceId: value.source.id, targetId: Number(target) },
                {
                  onSuccess: (r) => {
                    void window.bm.desktop.openExternal(r.url);
                    onClose();
                  },
                },
              )
            }
          >
            {t('merge.open')}
          </Button>
        </Group>
        <Text size="xs" c="dimmed">
          head = {value.source.name}
        </Text>
      </Stack>
    </Modal>
  );
}
