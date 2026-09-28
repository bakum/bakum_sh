import { useState } from 'react';
import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Group,
  Indicator,
  Popover,
  Select,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
  useMantineColorScheme,
  useComputedColorScheme,
} from '@mantine/core';
import { IconBell, IconBrandDocker, IconGitBranch, IconMoon, IconSun } from '@tabler/icons-react';
import { useBm, useBmMutation } from '../lib/query';
import { useCoreEvents } from '../lib/events';
import { fmtAgo } from '../lib/format';
import { HEADER_BG } from '../theme';
import classes from './Shell.module.css';
import { AppFooter } from './AppFooter';

const JOB_LABELS: Record<string, string> = {
  build: 'Сборка',
  start: 'Запуск',
  stop: 'Остановка',
  restart: 'Перезапуск',
  drop: 'Отбросить',
  delete_branch: 'Удаление ветки',
  import_backup: 'Импорт бэкапа',
  fetch: 'Fetch',
  apply_config: 'Применить конфигурацию',
};

export function Shell() {
  const { pid } = useParams();
  const nav = useNavigate();
  const projects = useBm('projects.list', {});
  const status = useBm('system.status', {}, { refetchInterval: 15000 });
  const jobs = useBm('jobs.list', { active: true }, { refetchInterval: 5000 });
  const { coreRestartedAt } = useCoreEvents();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const startDocker = useBmMutation('system.startDocker', { success: 'Docker Desktop запускается…' });
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme('light');

  const current = pid ?? projects.data?.[0]?.id;
  const dockerOk = status.data?.docker.ok ?? true;
  const activeJobs = jobs.data ?? [];

  const link = (to: string, label: string) => (
    <NavLink to={to} className={({ isActive }) => `${classes.link} ${isActive ? classes.active : ''}`}>
      {label}
    </NavLink>
  );

  return (
    <Box className={classes.root}>
      <Group className={classes.header} style={{ background: HEADER_BG }} gap={0} wrap="nowrap">
        <UnstyledButton className={classes.logo} onClick={() => nav('/')}>
          <IconGitBranch size={20} />
          <Text fw={700} c="white" size="sm">
            Odoo&nbsp;Branch&nbsp;Manager
          </Text>
        </UnstyledButton>
        {current ? (
          <Group gap={0} className={classes.nav} wrap="nowrap">
            {link(`/projects/${current}/branches`, 'Branches')}
            {link(`/projects/${current}/builds`, 'Builds')}
            {link('/status', 'Status')}
            {link(`/projects/${current}/audit`, 'Audit Logs')}
            {link(`/projects/${current}/settings`, 'Settings')}
          </Group>
        ) : (
          <Group gap={0} className={classes.nav}>
            {link('/status', 'Status')}
          </Group>
        )}
        <Group gap="xs" ml="auto" pr="md" wrap="nowrap">
          <Select
            size="xs"
            w={220}
            placeholder="Проект"
            value={current ?? null}
            data={[...(projects.data ?? []).map((p) => ({ value: p.id, label: p.name })), { value: '__new', label: '+ Добавить проект…' }]}
            onChange={(v) => {
              if (v === '__new') nav('/projects/new');
              else if (v) nav(`/projects/${v}/branches`);
            }}
            allowDeselect={false}
            comboboxProps={{ withinPortal: true }}
            aria-label="Проект"
          />
          <Popover width={360} position="bottom-end" shadow="md">
            <Popover.Target>
              <Indicator disabled={!activeJobs.length} label={activeJobs.length} size={16} color="orange">
                <ActionIcon c="white" size="lg" aria-label="Задачи и уведомления">
                  <IconBell size={20} />
                </ActionIcon>
              </Indicator>
            </Popover.Target>
            <Popover.Dropdown>
              <Stack gap={6}>
                <Text fw={600} size="sm">
                  Активные задачи
                </Text>
                {!activeJobs.length && (
                  <Text size="sm" c="dimmed">
                    Нет активных задач
                  </Text>
                )}
                {activeJobs.map((j) => (
                  <Group key={j.id} justify="space-between" wrap="nowrap">
                    <Text size="sm">
                      {JOB_LABELS[j.type] ?? j.type} {j.params.branch ? `· ${String(j.params.branch)}` : ''}
                    </Text>
                    <Badge size="xs" color={j.status === 'running' ? 'orange' : 'gray'}>
                      {j.status === 'running' ? 'идёт' : 'в очереди'} {fmtAgo(j.createdAt)}
                    </Badge>
                  </Group>
                ))}
              </Stack>
            </Popover.Dropdown>
          </Popover>
          <Tooltip label={status.data?.docker.text ?? 'Docker'}>
            <Group gap={4} c="white" wrap="nowrap" onClick={() => nav('/status')} style={{ cursor: 'pointer' }}>
              <IconBrandDocker size={20} />
              <Box className={classes.dot} style={{ background: dockerOk ? '#40c057' : '#fa5252' }} />
            </Group>
          </Tooltip>
          <ActionIcon c="white" onClick={() => setColorScheme(scheme === 'dark' ? 'light' : 'dark')} aria-label="Тема">
            {scheme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
          </ActionIcon>
        </Group>
      </Group>

      {!dockerOk && (
        <Alert color="red" radius={0} py={6} title={null}>
          <Group justify="space-between">
            <Text size="sm">
              Docker Desktop не запущен — сборки, логи и статусы недоступны. После запуска приложение продолжит работу само.
            </Text>
            <Button color="red" loading={startDocker.isPending} onClick={() => startDocker.mutate({})}>
              Запустить
            </Button>
          </Group>
        </Alert>
      )}
      {coreRestartedAt && dismissed !== coreRestartedAt && (
        <Alert color="orange" radius={0} py={6} withCloseButton onClose={() => setDismissed(coreRestartedAt)}>
          <Text size="sm">
            Core был перезапущен в {new Date(coreRestartedAt).toLocaleTimeString('ru-RU')}. Состояние согласовано с Docker и
            реестром; прерванные задачи отмечены как interrupted.
          </Text>
        </Alert>
      )}
      <Box className={classes.main}>
        <Outlet />
      </Box>
      <AppFooter />
    </Box>
  );
}
