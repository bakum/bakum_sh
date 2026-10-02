import { useEffect, useState } from 'react';
import { Alert, Anchor, Button, Code, Group, PasswordInput, ScrollArea, Stack, Text, TextInput } from '@mantine/core';
import { IconCheck, IconFolder, IconLogin, IconKey } from '@tabler/icons-react';
import type { RepoProbe } from '@bm/shared';
import { useBm, useBmMutation } from '../lib/query';
import { isMac } from '../lib/bm';

const DONE = ['success', 'failed', 'cancelled', 'interrupted'];

const repoName = (url: string): string => (/([^/:]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1] ?? 'repo').replace(/[^\w.-]/g, '-');

/**
 * Repository by URL (docs/decisions.md D31, D33): access check → sign-in window or token when the repository is private →
 * `mirror` — the app's own copy of the project repository (folder chosen by the app) / otherwise a clone into a chosen
 * folder (Enterprise) → job with its log. Credentials go to the Git credential helper, never to the app.
 */
export function RepoClone(props: {
  /** The project repository: the app's own bare copy in its data folder (D33). */
  mirror?: boolean;
  /** Address to start with (taken from the user's folder). */
  initialUrl?: string;
  /** Branch to clone alone, shallow (Enterprise addons of one Odoo series). */
  branch?: string;
  shallow?: boolean;
  suffix?: string;
  placeholder?: string;
  onCloned: (dir: string, url: string) => void;
}) {
  const [url, setUrl] = useState(props.initialUrl ?? '');
  const [probe, setProbe] = useState<RepoProbe | null>(null);
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('x-access-token');
  const [dir, setDir] = useState('');
  const [jobId, setJobId] = useState<number | null>(null);
  const probeM = useBmMutation('repo.probe');
  const loginM = useBmMutation('repo.login');
  const tokenM = useBmMutation('repo.saveToken');
  const dirM = useBmMutation('repo.defaultDir', { silentError: true });
  const cloneM = useBmMutation('repo.clone');
  const job = useBm('jobs.get', { jobId: jobId ?? 1 }, { enabled: !!jobId, refetchInterval: (q) => (q.state.data && DONE.includes(q.state.data.status) ? false : 1000) });
  const running = !!jobId && !(job.data && DONE.includes(job.data.status));
  const jlog = useBm('jobs.log', { jobId: jobId ?? 1, tail: 40 }, { enabled: !!jobId, refetchInterval: running ? 1000 : false });

  const accept = (p: RepoProbe) => {
    setProbe(p);
    if (p.ok) {
      setUrl(p.url);
      if (!props.mirror) dirM.mutate({ url: p.url, suffix: props.suffix }, { onSuccess: (r) => setDir((d) => d || r.dir) });
    }
  };

  useEffect(() => {
    if (job.data?.status === 'success') props.onCloned(dir, url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.data?.status]);

  const branchMissing = probe?.ok && props.branch && !probe.branches.includes(props.branch);
  const busy = probeM.isPending || loginM.isPending || tokenM.isPending;

  return (
    <Stack gap="xs">
      <Group align="flex-end">
        <TextInput
          style={{ flex: 1 }}
          label="Адрес репозитория"
          placeholder={props.placeholder ?? 'https://github.com/owner/repo.git или git@github.com:owner/repo.git'}
          value={url}
          disabled={running}
          onChange={(e) => {
            setUrl(e.currentTarget.value);
            setProbe(null);
          }}
        />
        <Button disabled={!url.trim() || running} loading={probeM.isPending} onClick={() => probeM.mutate({ url: url.trim() }, { onSuccess: accept })}>
          Проверить доступ
        </Button>
      </Group>

      {probe?.ok && (
        <Alert color="teal" variant="light" icon={<IconCheck size={16} />}>
          Доступ есть: веток {probe.branches.length}
          {probe.defaultBranch ? `, основная — ${probe.defaultBranch}` : ''}.
          {branchMissing && <Text size="sm" c="orange">Ветки {props.branch} в репозитории нет — клонировать нечего.</Text>}
        </Alert>
      )}

      {probe && !probe.ok && (
        <Alert color={probe.problem === 'network' ? 'orange' : 'red'} variant="light" title="Нет доступа">
          <Stack gap="xs">
            <Text size="sm">{probe.message}</Text>
            {(probe.problem === 'auth' || probe.problem === 'denied') && probe.https && (
              <>
                <Group gap="xs">
                  <Button
                    size="xs"
                    leftSection={<IconLogin size={14} />}
                    loading={loginM.isPending}
                    disabled={busy && !loginM.isPending}
                    onClick={() => loginM.mutate({ url: probe.url }, { onSuccess: accept })}
                  >
                    Войти через браузер
                  </Button>
                  <Text size="xs" c="dimmed">
                    Откроется окно Git Credential Manager; учётные данные сохранит {isMac ? 'Связка ключей' : 'Windows'}.
                  </Text>
                </Group>
                <Text size="sm" fw={600} mt={4}>
                  Или токен доступа
                </Text>
                <Text size="xs" c="dimmed">
                  GitHub → Settings → Developer settings → Personal access tokens: fine-grained, доступ к этому репозиторию, Contents — Read-only (для Fork, который создаёт ветки на GitHub, — Read and write).{' '}
                  <Anchor size="xs" onClick={() => void window.bm.desktop.openExternal('https://github.com/settings/personal-access-tokens/new')}>
                    Создать токен
                  </Anchor>
                  . Токен передаётся в Git ({isMac ? 'Связка ключей macOS' : 'хранилище учётных данных Windows'}), приложение его не сохраняет.
                </Text>
                <Group align="flex-end" gap="xs">
                  <PasswordInput style={{ flex: 1 }} size="xs" label="Токен" value={token} onChange={(e) => setToken(e.currentTarget.value)} />
                  <TextInput w={160} size="xs" label="Пользователь" value={username} onChange={(e) => setUsername(e.currentTarget.value)} />
                  <Button
                    size="xs"
                    variant="light"
                    leftSection={<IconKey size={14} />}
                    disabled={token.length < 8 || (busy && !tokenM.isPending)}
                    loading={tokenM.isPending}
                    onClick={() =>
                      tokenM.mutate(
                        { url: probe.url, username, token },
                        {
                          onSuccess: (p) => {
                            setToken('');
                            accept(p);
                          },
                        },
                      )
                    }
                  >
                    Сохранить токен
                  </Button>
                </Group>
              </>
            )}
            {(probe.problem === 'ssh-key' || probe.problem === 'host-key') && (
              <Text size="xs" c="dimmed">
                Для SSH-адреса нужны ключ в ssh-agent и ключ хоста в known_hosts. Проще — https-адрес со входом через браузер.
              </Text>
            )}
          </Stack>
        </Alert>
      )}

      {probe?.ok && props.mirror && (
        <Group justify="space-between">
          <Text size="sm" c="dimmed">
            Приложение сделает свою копию репозитория в своей папке и будет брать из неё код сборок. Ваши клоны оно не трогает.
          </Text>
          <Button
            disabled={running || job.data?.status === 'success'}
            loading={cloneM.isPending || running}
            onClick={() =>
              cloneM.mutate(
                { url: probe.url, mirror: true, shallow: false },
                {
                  onSuccess: (r) => {
                    setDir(r.dir);
                    setJobId(r.jobId);
                  },
                },
              )
            }
          >
            Загрузить
          </Button>
        </Group>
      )}

      {probe?.ok && !props.mirror && !branchMissing && (
        <Group align="flex-end">
          <TextInput style={{ flex: 1 }} label="Куда клонировать" value={dir} disabled={running || job.data?.status === 'success'} onChange={(e) => setDir(e.currentTarget.value)} />
          <Button
            variant="default"
            leftSection={<IconFolder size={14} />}
            disabled={running}
            onClick={async () => {
              const parent = await window.bm.desktop.selectDirectory('Папка, в которую положить клон');
              if (parent) setDir(`${parent.replace(/[\\/]+$/, '')}/${repoName(url)}${props.suffix ?? ''}`);
            }}
          >
            Выбрать…
          </Button>
          <Button
            disabled={!dir || running || job.data?.status === 'success'}
            loading={cloneM.isPending || running}
            onClick={() => cloneM.mutate({ url: probe.url, dir, branch: props.branch, shallow: !!props.shallow, mirror: false }, { onSuccess: (r) => setJobId(r.jobId) })}
          >
            Клонировать
          </Button>
        </Group>
      )}

      {jobId && (
        <Stack gap={4}>
          {job.data?.status === 'failed' && (
            <Alert color="red" variant="light">
              {job.data.error}
            </Alert>
          )}
          {job.data?.status === 'success' && (
            <Text size="sm" c="teal">
              {props.mirror ? 'Загружено' : 'Клонировано'} в <Code>{dir}</Code>
            </Text>
          )}
          <ScrollArea h={120} type="auto" bg="var(--mantine-color-gray-light)" p={6} style={{ borderRadius: 4 }}>
            <Text component="pre" size="xs" ff="monospace" m={0}>
              {(jlog.data?.lines ?? []).join('\n') || 'ожидание…'}
            </Text>
          </ScrollArea>
        </Stack>
      )}
    </Stack>
  );
}
