import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Code, CopyButton, Group, List, Modal, Stack, Text, TextInput } from '@mantine/core';
import type { BranchView } from '@bm/shared';
import { useBm, useBmMutation } from '../../lib/query';
import { errorCode, errorText, isMac, type BmCallError } from '../../lib/bm';

/** Fork (spec 8.10, D33): the new branch is created on GitHub from the live build commit (or the branch head) → Development → build. */
export function ForkDialog({ open, branch, onClose }: { open: boolean; branch: BranchView; onClose: () => void }) {
  const nav = useNavigate();
  const [name, setName] = useState('');
  const preview = useBm('branches.forkName', { projectId: branch.projectId, name }, { enabled: open && !!name });
  const fork = useBmMutation('branches.fork', { success: 'Ветка создана, сборка поставлена в очередь', silentError: true });
  useEffect(() => {
    if (open) setName('');
    fork.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const from = branch.liveBuild?.commitSha ? `коммита живой сборки ${branch.liveBuild.commitSha.slice(0, 7)}` : `последнего коммита ${branch.name}`;
  const run = (interactive: boolean) =>
    fork.mutate(
      { branchId: branch.id, name: preview.data!.name, interactive },
      {
        onSuccess: (r) => {
          onClose();
          nav(`/projects/${branch.projectId}/branches/${r.branch.id}`);
        },
      },
    );
  return (
    <Modal opened={open} onClose={onClose} title={`Fork от ${branch.name}`} size={fork.error ? 'lg' : 'md'}>
      <Stack>
        <TextInput
          label="Имя новой ветки"
          placeholder="test999"
          value={name}
          onChange={(e) => {
            setName(e.currentTarget.value);
            fork.reset();
          }}
          data-autofocus
        />
        {preview.data && (
          <Text size="sm">
            Ветка <b>{preview.data.name}</b> будет создана в репозитории на GitHub от {from}. Её создаёт Git этого компьютера от имени
            учётной записи GitHub, под которой он вошёл; этой учётной записи нужна роль Write или выше.
          </Text>
        )}
        {preview.data?.error && <Alert color="red">{preview.data.error}</Alert>}
        {fork.error && <ForkError error={fork.error} busy={fork.isPending} onLogin={() => run(true)} />}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Отмена
          </Button>
          <Button disabled={!preview.data?.valid} loading={fork.isPending} onClick={() => run(false)}>
            Создать ветку
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

interface PushDetails {
  problem?: string;
  account?: string | null;
  https?: boolean;
  urlUser?: string | null;
}

function Cmd({ cmd }: { cmd: string }) {
  return (
    <Group gap={6} wrap="nowrap">
      <Code>{cmd}</Code>
      <CopyButton value={cmd}>
        {({ copied, copy }) => (
          <Button size="compact-xs" variant="subtle" onClick={copy}>
            {copied ? 'Скопировано' : 'Копировать'}
          </Button>
        )}
      </CopyButton>
    </Group>
  );
}

/** What went wrong with the push and what to do next (D57): the app may run on machines of people it was not set up by. */
function ForkError({ error, busy, onLogin }: { error: Error; busy: boolean; onLogin: () => void }) {
  const d = (errorCode(error) === 'GIT_PUSH' ? ((error as BmCallError).details as PushDetails | undefined) : undefined) ?? {};
  const login = d.https && (d.problem === 'auth' || d.problem === 'denied');
  const loginButton = login && (
    <Group>
      <Button size="xs" variant="light" loading={busy} onClick={onLogin}>
        Войти и повторить
      </Button>
    </Group>
  );
  const token = d.urlUser && (
    <List.Item>
      Проект подключён по токену (пользователь <Code>{d.urlUser}</Code> в адресе репозитория). Токену нужен доступ к этому репозиторию с
      правом Contents — Read and write. Создайте такой токен на GitHub и замените им пароль записи{' '}
      <Code>{isMac ? `github.com (${d.urlUser})` : `git:https://${d.urlUser}@github.com`}</Code>{' '}
      {isMac ? 'в приложении «Связка ключей» (тип «пароль интернета»).' : 'в «Диспетчере учётных данных Windows» → «Учётные данные Windows».'}
    </List.Item>
  );
  return (
    <Alert color="red" title="Ветка не создана" data-testid="fork-error">
      <Stack gap="xs">
        <Text size="sm">{errorText(error).replace(/^git push: /, '')}</Text>
        {d.problem === 'auth' && (
          <>
            <Text size="sm">
              Git на этом компьютере не вошёл в GitHub или вход устарел. Для публичного репозитория fetch работает и без входа, а создать
              ветку — нет.
            </Text>
            {d.https ? (
              <Text size="sm">
                Нажмите «Войти и повторить»: откроется окно Git Credential Manager. Войдите учётной записью с ролью Write в этом
                репозитории.
              </Text>
            ) : null}
            {loginButton}
          </>
        )}
        {d.problem === 'denied' && (
          <>
            <List size="sm" spacing={4}>
              <List.Item>
                Попросите администратора репозитория выдать {d.account ? <b>{d.account}</b> : 'вашей учётной записи'} роль Write (GitHub →
                репозиторий → Settings → Collaborators and teams).
              </List.Item>
              {d.https && (
                <List.Item>
                  Или войдите другой учётной записью: выполните в терминале
                  <Cmd cmd={d.account ? `git credential-manager github logout ${d.account}` : 'git credential-manager github list'} />
                  {d.account
                    ? 'и нажмите «Войти и повторить».'
                    : 'Команда покажет, под кем вошёл Git; выйдите командой git credential-manager github logout <учётная запись> и нажмите «Войти и повторить».'}
                </List.Item>
              )}
              {token}
              {!d.urlUser && !d.account && (
                <List.Item>
                  Если Git вошёл по fine-grained токену, ему нужен доступ к этому репозиторию с правом Contents — Read and write. Токены
                  для репозиториев организации может потребоваться одобрить её владельцу.
                </List.Item>
              )}
            </List>
            {loginButton}
          </>
        )}
        {d.problem === 'rules' && (
          <Text size="sm">
            Выберите другое имя ветки или попросите администратора разрешить такие ветки (GitHub → репозиторий → Settings → Rules или
            Branches).
          </Text>
        )}
        {d.problem === 'network' && <Text size="sm">Проверьте подключение к интернету, прокси или VPN и повторите.</Text>}
      </Stack>
    </Alert>
  );
}
