import { useEffect, useState } from 'react';
import { Alert, Button, Card, Code, Group, SegmentedControl, Stack, Text, TextInput } from '@mantine/core';
import { IconBrandVscode, IconFolder, IconFolderOpen, IconCursorText } from '@tabler/icons-react';
import type { BranchView } from '@bm/shared';
import { useBm, useBmMutation } from '../../lib/query';
import { call, isMac } from '../../lib/bm';
import { shellOpen } from '../BranchPage';

type Source = 'github' | 'folder';

/**
 * Editor (spec 8.9, D33): where the code of the branch comes from and opening it in VS Code / Cursor / Explorer.
 * Code from GitHub lives in a worktree of the app's own copy (read-only for you); a Development branch can take the
 * code from your own clone instead — the build mounts it as is, Restart picks up Python edits without a commit.
 */
export function EditorTab({ branch }: { branch: BranchView }) {
  const project = useBm('projects.get', { projectId: branch.projectId });
  const ensure = useBmMutation('branches.ensureWorktree', { success: 'Worktree создан' });
  const save = useBmMutation('branches.setOverrides', { success: 'Источник кода сохранён. Нажмите «Применить» или Rebuild, чтобы сборка взяла код оттуда.' });
  const [source, setSource] = useState<Source>(branch.folder ? 'folder' : 'github');
  const [folder, setFolder] = useState(branch.folder ?? '');
  const suggested = project.data?.config?.repo.localFolder ?? '';
  useEffect(() => {
    setSource(branch.folder ? 'folder' : 'github');
    setFolder(branch.folder ?? '');
  }, [branch.folder]);

  const apply = async (next: string | null) => {
    const eff = await call('config.effective', { branchId: branch.id });
    const overrides = { ...eff.branchOverrides };
    delete overrides.folder;
    save.mutate({ branchId: branch.id, overrides: next ? { ...overrides, folder: next } : overrides });
  };

  const dev = branch.stage === 'development';
  const changed = source === 'github' ? !!branch.folder : (folder.trim() || null) !== branch.folder;

  return (
    <Stack>
      <Card withBorder>
        <Stack gap="xs">
          <Group justify="space-between">
            <Text fw={600}>Откуда берётся код</Text>
            {dev && (
              <SegmentedControl
                value={source}
                onChange={(v) => {
                  setSource(v as Source);
                  if (v === 'folder' && !folder) setFolder(suggested);
                }}
                data={[
                  { value: 'github', label: 'С GitHub' },
                  { value: 'folder', label: 'Из моей папки' },
                ]}
              />
            )}
          </Group>
          {source === 'github' ? (
            <Text size="sm" c="dimmed">
              Сборка берёт код ветки с GitHub: приложение держит свою копию репозитория и отдельную папку ветки. Правьте код у себя, коммитьте и делайте
              push — приложение подхватит коммит при следующем обновлении. Ваш репозиторий приложение не трогает.
              {!dev && ' Свою папку можно подключить у веток Development.'}
            </Text>
          ) : (
            <>
              <Text size="sm" c="dimmed">
                Сборка монтирует вашу папку как есть: Restart показывает правки Python без коммита, новый коммит в папке запускает обновление сборки.
                Приложение только читает папку и ничего в ней не меняет. Если в папке открыта другая ветка, сборка блокируется (работает только Stop) до
                возврата на {branch.name}.
              </Text>
              {branch.folder && branch.folderBranch && folder.trim() === branch.folder && (
                <Text size="sm" c={branch.folderBlocked ? 'red' : 'teal'} data-testid="folder-branch">
                  Сейчас в папке открыта ветка <Code>{branch.folderBranch}</Code>
                  {branch.folderBlocked ? ` — не ${branch.name}: сборка заблокирована.` : '.'}
                </Text>
              )}
              <Group align="flex-end">
                <TextInput
                  style={{ flex: 1 }}
                  label="Папка вашего клона (корень репозитория)"
                  placeholder="E:\work\my-addons"
                  value={folder}
                  onChange={(e) => setFolder(e.currentTarget.value)}
                />
                <Button
                  variant="default"
                  leftSection={<IconFolder size={14} />}
                  onClick={async () => {
                    const p = await window.bm.desktop.selectDirectory('Папка вашего клона репозитория');
                    if (p) setFolder(p);
                  }}
                >
                  Выбрать…
                </Button>
              </Group>
            </>
          )}
          {dev && changed && (
            <Group justify="flex-end">
              <Button loading={save.isPending} disabled={source === 'folder' && !folder.trim()} onClick={() => void apply(source === 'folder' ? folder.trim() : null)}>
                Сохранить
              </Button>
            </Group>
          )}
        </Stack>
      </Card>

      {!branch.codeDir ? (
        <Alert color="gray">
          <Group justify="space-between">
            <Text size="sm">Папка ветки создаётся при первой сборке. Можно создать её сейчас, чтобы посмотреть код.</Text>
            <Button loading={ensure.isPending} onClick={() => ensure.mutate({ branchId: branch.id })}>
              Создать worktree
            </Button>
          </Group>
        </Alert>
      ) : (
        <Card withBorder>
          <Stack>
            <Text size="sm">
              Код ветки: <Code>{branch.codeDir}</Code>{' '}
              {branch.folder ? '(ваша папка)' : '(папка приложения на коммите с GitHub — правки здесь не нужны, они мешают следующей сборке)'}
            </Text>
            <Group>
              <Button leftSection={<IconBrandVscode size={14} />} onClick={() => void shellOpen({ branchId: branch.id, target: 'editor' })}>
                Открыть в VS Code
              </Button>
              <Button variant="default" leftSection={<IconCursorText size={14} />} onClick={() => void shellOpen({ branchId: branch.id, target: 'editor-cursor' })}>
                Открыть в Cursor
              </Button>
              <Button variant="default" leftSection={<IconFolderOpen size={14} />} onClick={() => void shellOpen({ branchId: branch.id, target: 'explorer' })}>
                {isMac ? 'Открыть в Finder' : 'Открыть в Проводнике'}
              </Button>
            </Group>
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
