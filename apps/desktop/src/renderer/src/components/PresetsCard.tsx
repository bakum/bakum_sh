import { useState } from 'react';
import { ActionIcon, Button, Card, Group, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import { useBm, useBmMutation } from '../lib/query';
import { fmtDate } from '../lib/format';
import { t } from '../i18n';

/** Settings → Приложение: the saved presets (D73); they are made from a project, here they are only removed. */
export function PresetsCard() {
  const list = useBm('presets.list', {});
  const del = useBmMutation('presets.delete', { success: t('presets.deleted') });
  const items = list.data ?? [];
  const [confirm, setConfirm] = useState<string | null>(null);
  return (
    <Card withBorder>
      <Stack gap="xs">
        <Title order={5}>{t('presets.title')}</Title>
        <Text size="sm" c="dimmed">
          {t('presets.hint')}
        </Text>
        {items.length > 0 && (
          <Table verticalSpacing={4}>
            <Table.Tbody>
              {items.map((p) => (
                <Table.Tr key={p.file}>
                  <Table.Td>
                    <Text size="sm" fw={500}>
                      {p.name}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {p.file}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{t(`preset.${p.base}`)}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {p.from ? t('presets.from', { id: p.from }) : ''} {p.savedAt ? fmtDate(p.savedAt) : ''}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Group justify="flex-end" gap={4} wrap="nowrap">
                      {confirm === p.file ? (
                        <>
                          <Button size="compact-xs" color="red" loading={del.isPending} onClick={() => del.mutate({ file: p.file }, { onSettled: () => setConfirm(null) })}>
                            {t('common.delete')}
                          </Button>
                          <Button size="compact-xs" variant="default" onClick={() => setConfirm(null)}>
                            {t('common.cancel')}
                          </Button>
                        </>
                      ) : (
                        <Tooltip label={t('common.delete')}>
                          <ActionIcon variant="subtle" color="red" onClick={() => setConfirm(p.file)} aria-label={t('common.delete')}>
                            <IconTrash size={16} />
                          </ActionIcon>
                        </Tooltip>
                      )}
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
