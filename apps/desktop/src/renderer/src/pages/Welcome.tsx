import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Anchor, Button, Card, Center, Code, Group, List, SegmentedControl, Stack, Stepper, Text, Title } from '@mantine/core';
import { IconGitBranch } from '@tabler/icons-react';
import { useBm, useBmMutation } from '../lib/query';
import { isMac } from '../lib/bm';
import { COPYRIGHT_HOLDER, useBuildInfo } from '../components/AppFooter';
import { LANG_NAMES, LANGS, type Lang } from '@bm/shared';
import { t, tx, useLang } from '../i18n';

/** First-run wizard (spec 7): explains what the app does, writes app.yaml, then goes to "add project". */
export function Welcome() {
  const nav = useNavigate();
  const state = useBm('system.state', {});
  const status = useBm('system.status', { refresh: true }, { refetchInterval: 5000 });
  const finish = useBmMutation('system.completeFirstRun');
  const build = useBuildInfo().data;
  const { lang, setLang } = useLang();
  const code = { code: (x: ReactNode) => <Code>{x}</Code> };

  return (
    <Center h="100vh" bg="var(--mantine-color-gray-light)">
      <Card w={760} shadow="md" padding="xl" radius="md" withBorder>
        <Stack>
          <Group gap="sm" justify="space-between">
            <Group gap="sm">
              <IconGitBranch size={32} color="#714b67" />
              <Title order={2}>Odoo Branch Manager</Title>
            </Group>
            <SegmentedControl
              size="xs"
              value={lang}
              onChange={(v) => setLang(v as Lang)}
              data={LANGS.map((l) => ({ value: l, label: LANG_NAMES[l] }))}
              aria-label={t('shell.language')}
              data-testid="welcome-language"
            />
          </Group>
          <Text>{tx('welcome.intro', { url: t('welcome.urlSample') }, code)}</Text>
          <Stepper active={0} size="sm">
            <Stepper.Step label={t('welcome.stepApp')} description={t('welcome.stepAppDesc')} />
            <Stepper.Step label={t('welcome.stepProject')} description={t('welcome.stepProjectDesc')} />
            <Stepper.Step label={t('welcome.stepBuilds')} description={t('welcome.stepBuildsDesc')} />
          </Stepper>
          <List size="sm" spacing={4}>
            <List.Item>
              {t('welcome.settings')} <Code>{state.data?.configDir ?? '…'}</Code>
            </List.Item>
            <List.Item>
              {t('welcome.data')} <Code>{state.data?.dataDir ?? '…'}</Code>
            </List.Item>
            <List.Item>
              Docker: {status.data ? (status.data.docker.ok ? status.data.docker.text : t('welcome.dockerDown')) : '…'}
            </List.Item>
            <List.Item>Git: {status.data ? status.data.git.text : '…'}</List.Item>
            <List.Item>{t('welcome.ports')}</List.Item>
          </List>
          {status.data && !status.data.git.ok && (
            <Alert color="red" variant="light" title={t('welcome.needGit')}>
              {isMac ? (
                tx('welcome.gitMac', {}, code)
              ) : (
                <>
                  {t('welcome.gitWin')}{' '}
                  <Anchor size="sm" onClick={() => void window.bm.desktop.openExternal('https://git-scm.com/download/win')}>
                    {t('welcome.gitDownload')}
                  </Anchor>
                  {t('welcome.gitInstall')}
                </>
              )}
            </Alert>
          )}
          {status.data && !status.data.docker.ok && (
            <Alert color="orange" variant="light" title={t('welcome.needDocker')}>
              {t('welcome.dockerRuns')}{' '}
              <Anchor size="sm" onClick={() => void window.bm.desktop.openExternal('https://www.docker.com/products/docker-desktop/')}>
                {t('welcome.dockerInstall')}
              </Anchor>{' '}
              {isMac ? '(Apple Silicon)' : '(WSL2)'} {t('welcome.dockerOrStart')}
            </Alert>
          )}
          <Alert color="blue" variant="light">
            {t('welcome.localOnly')}
          </Alert>
          <Group justify="flex-end">
            <Button
              size="sm"
              loading={finish.isPending}
              onClick={() => finish.mutate({ language: lang }, { onSuccess: () => nav('/projects/new', { replace: true }) })}
            >
              {t('welcome.next')}
            </Button>
          </Group>
          <Text size="xs" c="dimmed" ta="center">
            Odoo Branch Manager {build ? `v${build.version}` : ''} · © {build ? new Date(build.buildDate).getFullYear() : new Date().getFullYear()}{' '}
            {COPYRIGHT_HOLDER}
          </Text>
        </Stack>
      </Card>
    </Center>
  );
}
