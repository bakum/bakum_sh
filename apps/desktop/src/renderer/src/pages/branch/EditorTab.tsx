import { Alert, Button, Card, Code, Group, Stack, Text } from '@mantine/core';
import { IconBrandVscode, IconFolderOpen, IconCursorText } from '@tabler/icons-react';
import type { BranchView } from '@bm/shared';
import { useBmMutation } from '../../lib/query';
import { shellOpen } from '../BranchPage';

/** Editor (spec 8.9): open the branch worktree (not the main checkout) in VS Code / Cursor / Explorer. */
export function EditorTab({ branch }: { branch: BranchView }) {
  const ensure = useBmMutation('branches.ensureWorktree', { success: 'Worktree создан' });
  return (
    <Stack>
      {!branch.worktreePath ? (
        <Alert color="gray">
          <Group justify="space-between">
            <Text size="sm">Worktree ветки создаётся при первой сборке. Можно создать его сейчас, чтобы начать правки.</Text>
            <Button loading={ensure.isPending} onClick={() => ensure.mutate({ branchId: branch.id })}>
              Создать worktree
            </Button>
          </Group>
        </Alert>
      ) : (
        <Card withBorder>
          <Stack>
            <Text size="sm">
              Worktree ветки: <Code>{branch.worktreePath}</Code> ({branch.tracking === 'local' ? 'локальная ветка — правки и коммиты здесь запускают обновление сборки' : 'detached на origin — только чтение, правки не затираются'})
            </Text>
            <Group>
              <Button leftSection={<IconBrandVscode size={14} />} onClick={() => void shellOpen({ branchId: branch.id, target: 'editor' })}>
                Открыть в VS Code
              </Button>
              <Button variant="default" leftSection={<IconCursorText size={14} />} onClick={() => void shellOpen({ branchId: branch.id, target: 'editor-cursor' })}>
                Открыть в Cursor
              </Button>
              <Button variant="default" leftSection={<IconFolderOpen size={14} />} onClick={() => void shellOpen({ branchId: branch.id, target: 'explorer' })}>
                Открыть в Проводнике
              </Button>
            </Group>
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
