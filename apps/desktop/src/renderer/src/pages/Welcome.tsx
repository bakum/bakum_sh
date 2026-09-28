import { useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Center, Code, Group, List, Stack, Stepper, Text, Title } from '@mantine/core';
import { IconGitBranch } from '@tabler/icons-react';
import { useBm, useBmMutation } from '../lib/query';
import { COPYRIGHT_HOLDER, useBuildInfo } from '../components/AppFooter';

/** First-run wizard (spec 7): explains what the app does, writes app.yaml, then goes to "add project". */
export function Welcome() {
  const nav = useNavigate();
  const state = useBm('system.state', {});
  const status = useBm('system.status', { refresh: true });
  const finish = useBmMutation('system.completeFirstRun');
  const build = useBuildInfo().data;

  return (
    <Center h="100vh" bg="var(--mantine-color-gray-light)">
      <Card w={760} shadow="md" padding="xl" radius="md" withBorder>
        <Stack>
          <Group gap="sm">
            <IconGitBranch size={32} color="#714b67" />
            <Title order={2}>Odoo Branch Manager</Title>
          </Group>
          <Text>
            Локальный odoo.sh: ветки git-репозитория раскладываются по стадиям Production / Staging / Development, на каждую
            ветку собирается своя сборка Odoo (контейнер + БД + код) и открывается по адресу <Code>http://&lt;ветка&gt;.localhost</Code>.
          </Text>
          <Stepper active={0} size="sm">
            <Stepper.Step label="Приложение" description="папки и порт" />
            <Stepper.Step label="Проект" description="репозиторий" />
            <Stepper.Step label="Сборки" description="ветки и стадии" />
          </Stepper>
          <List size="sm" spacing={4}>
            <List.Item>
              Настройки: <Code>{state.data?.configDir ?? '…'}</Code>
            </List.Item>
            <List.Item>
              Данные, реестр и логи: <Code>{state.data?.dataDir ?? '…'}</Code>
            </List.Item>
            <List.Item>
              Docker: {status.data ? (status.data.docker.ok ? status.data.docker.text : 'не запущен — запустите Docker Desktop') : '…'}
            </List.Item>
            <List.Item>
              Сборки доступны через Traefik на порту 80, а если он занят — на 8080. Приложение само не открывает сетевых портов.
            </List.Item>
          </List>
          <Alert color="blue" variant="light">
            Приложение работает только с локальным Docker и Postgres. С настоящим продом оно не соединяется: зеркало прода собирается из
            файла бэкапа.
          </Alert>
          <Group justify="flex-end">
            <Button
              size="sm"
              loading={finish.isPending}
              onClick={() => finish.mutate({}, { onSuccess: () => nav('/projects/new', { replace: true }) })}
            >
              Далее: добавить проект
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
