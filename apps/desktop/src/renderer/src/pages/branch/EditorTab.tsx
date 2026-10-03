import { useEffect, useState } from 'react';
import { Alert, Button, Card, Code, Group, SegmentedControl, Stack, Text, TextInput } from '@mantine/core';
import { IconBrandVscode, IconFolder, IconFolderOpen, IconCursorText } from '@tabler/icons-react';
import type { BranchView } from '@bm/shared';
import { useBm, useBmMutation } from '../../lib/query';
import { call, isMac } from '../../lib/bm';
import { shellOpen } from '../BranchPage';
import { t, tx } from '../../i18n';

type Source = 'github' | 'folder';

/**
 * Editor (spec 8.9, D33): where the code of the branch comes from and opening it in VS Code / Cursor / Explorer.
 * Code from GitHub lives in a worktree of the app's own copy (read-only for you); a Development branch can take the
 * code from your own clone instead — the build mounts it as is, Restart picks up Python edits without a commit.
 */
export function EditorTab({ branch }: { branch: BranchView }) {
  const project = useBm('projects.get', { projectId: branch.projectId });
  const ensure = useBmMutation('branches.ensureWorktree', { success: t('editor.worktreeCreated') });
  const save = useBmMutation('branches.setOverrides', { success: t('editor.saved') });
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
            <Text fw={600}>{t('editor.source')}</Text>
            {dev && (
              <SegmentedControl
                value={source}
                onChange={(v) => {
                  setSource(v as Source);
                  if (v === 'folder' && !folder) setFolder(suggested);
                }}
                data={[
                  { value: 'github', label: t('editor.github') },
                  { value: 'folder', label: t('editor.folder') },
                ]}
              />
            )}
          </Group>
          {source === 'github' ? (
            <Text size="sm" c="dimmed">
              {t('editor.githubHint')}
              {!dev && t('editor.devOnly')}
            </Text>
          ) : (
            <>
              <Text size="sm" c="dimmed">
                {t('editor.folderHint', { branch: branch.name })}
              </Text>
              {branch.folder && branch.folderBranch && folder.trim() === branch.folder && (
                <Text size="sm" c={branch.folderBlocked ? 'red' : 'teal'} data-testid="folder-branch">
                  {tx('editor.openBranch', { open: branch.folderBranch }, { code: (x) => <Code>{x}</Code> })}
                  {branch.folderBlocked ? t('editor.blocked', { branch: branch.name }) : '.'}
                </Text>
              )}
              <Group align="flex-end">
                <TextInput
                  style={{ flex: 1 }}
                  label={t('editor.cloneFolder')}
                  placeholder="E:\work\my-addons"
                  value={folder}
                  onChange={(e) => setFolder(e.currentTarget.value)}
                />
                <Button
                  variant="default"
                  leftSection={<IconFolder size={14} />}
                  onClick={async () => {
                    const p = await window.bm.desktop.selectDirectory(t('editor.chooseClone'));
                    if (p) setFolder(p);
                  }}
                >
                  {t('repo.choose')}
                </Button>
              </Group>
            </>
          )}
          {dev && changed && (
            <Group justify="flex-end">
              <Button loading={save.isPending} disabled={source === 'folder' && !folder.trim()} onClick={() => void apply(source === 'folder' ? folder.trim() : null)}>
                {t('common.save')}
              </Button>
            </Group>
          )}
        </Stack>
      </Card>

      {!branch.codeDir ? (
        <Alert color="gray">
          <Group justify="space-between">
            <Text size="sm">{t('editor.noWorktree')}</Text>
            <Button loading={ensure.isPending} onClick={() => ensure.mutate({ branchId: branch.id })}>
              {t('editor.createWorktree')}
            </Button>
          </Group>
        </Alert>
      ) : (
        <Card withBorder>
          <Stack>
            <Text size="sm">
              {t('editor.codeDir')} <Code>{branch.codeDir}</Code> {t(branch.folder ? 'editor.yourFolder' : 'editor.appFolder')}
            </Text>
            <Group>
              <Button leftSection={<IconBrandVscode size={14} />} onClick={() => void shellOpen({ branchId: branch.id, target: 'editor' })}>
                {t('editor.vscode')}
              </Button>
              <Button variant="default" leftSection={<IconCursorText size={14} />} onClick={() => void shellOpen({ branchId: branch.id, target: 'editor-cursor' })}>
                {t('editor.cursor')}
              </Button>
              <Button variant="default" leftSection={<IconFolderOpen size={14} />} onClick={() => void shellOpen({ branchId: branch.id, target: 'explorer' })}>
                {t(isMac ? 'editor.finder' : 'editor.explorer')}
              </Button>
            </Group>
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
