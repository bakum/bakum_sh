import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
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
import { useHotkeys } from '@mantine/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { IconBell, IconBrandDocker, IconGitBranch, IconMoon, IconSun } from '@tabler/icons-react';
import { useBm, useBmMutation } from '../lib/query';
import { BRANCH_FILTER_ID } from './Sidebar';
import { EditionBadge } from './EditionBadge';
import { useCoreEvents } from '../lib/events';
import { fmtAgo, fmtTime, jobLabel } from '../lib/format';
import { HEADER_BG } from '../theme';
import classes from './Shell.module.css';
import { AppFooter } from './AppFooter';
import { UpdateBanner } from './UpdateBanner';
import { ErrorBoundary } from './ErrorBoundary';
import { t } from '../i18n';


export function Shell() {
  const { pid } = useParams();
  const nav = useNavigate();
  const loc = useLocation();
  const projects = useBm('projects.list', {});
  const status = useBm('system.status', {}, { refetchInterval: 15000 });
  const jobs = useBm('jobs.list', { active: true }, { refetchInterval: 5000 });
  const { coreRestartedAt } = useCoreEvents();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const startDocker = useBmMutation('system.startDocker', { success: t('shell.dockerStarting') });
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme('light');

  const current = pid ?? projects.data?.[0]?.id;
  const dockerOk = status.data?.docker.ok ?? true;
  const activeJobs = jobs.data ?? [];

  // Spec 7 hotkeys: Ctrl+K — branch search, Ctrl+R — fetch, F5 — refresh the screen (Cmd on macOS). They also work
  // from inputs; Ctrl+K is left to Monaco and xterm (their textarea), where it is a chord of their own.
  const qc = useQueryClient();
  const fetchM = useBmMutation('git.fetch', { success: t('branches.fetchStarted') });
  const focusBranchFilter = () => {
    const el = document.getElementById(BRANCH_FILTER_ID);
    if (el instanceof HTMLInputElement) {
      el.focus();
      el.select();
    } else if (current) nav(`/projects/${current}/branches`, { state: { focusFilter: true } });
  };
  useHotkeys([['mod+K', focusBranchFilter]], ['TEXTAREA']);
  useHotkeys(
    [
      ['mod+R', () => current && !fetchM.isPending && fetchM.mutate({ projectId: current })],
      ['F5', () => void qc.invalidateQueries()],
    ],
    [],
  );

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
          <EditionBadge short edition={projects.data?.find((p) => p.id === current)?.edition} />
          <Select
            size="xs"
            w={220}
            placeholder={t('shell.project')}
            value={current ?? null}
            data={[...(projects.data ?? []).map((p) => ({ value: p.id, label: p.name })), { value: '__new', label: t('shell.addProject') }]}
            onChange={(v) => {
              if (v === '__new') nav('/projects/new');
              else if (v) nav(`/projects/${v}/branches`);
            }}
            allowDeselect={false}
            comboboxProps={{ withinPortal: true }}
            aria-label={t('shell.project')}
          />
          <Popover width={360} position="bottom-end" shadow="md">
            <Popover.Target>
              <Indicator disabled={!activeJobs.length} label={activeJobs.length} size={16} color="orange">
                <ActionIcon c="white" size="lg" aria-label={t('shell.jobs')}>
                  <IconBell size={20} />
                </ActionIcon>
              </Indicator>
            </Popover.Target>
            <Popover.Dropdown>
              <Stack gap={6}>
                <Text fw={600} size="sm">
                  {t('shell.activeJobs')}
                </Text>
                {!activeJobs.length && (
                  <Text size="sm" c="dimmed">
                    {t('shell.noJobs')}
                  </Text>
                )}
                {activeJobs.map((j) => (
                  <Group key={j.id} justify="space-between" wrap="nowrap">
                    <Text size="sm">
                      {jobLabel(j.type)} {j.params.branch ? `· ${String(j.params.branch)}` : ''}
                    </Text>
                    <Badge size="xs" color={j.status === 'running' ? 'orange' : 'gray'}>
                      {t(j.status === 'running' ? 'shell.running' : 'shell.queued')} {fmtAgo(j.createdAt)}
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
          <ActionIcon c="white" onClick={() => setColorScheme(scheme === 'dark' ? 'light' : 'dark')} aria-label={t('shell.theme')}>
            {scheme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
          </ActionIcon>
        </Group>
      </Group>

      {!dockerOk && (
        <Alert color="red" radius={0} py={6} title={null}>
          <Group justify="space-between">
            <Text size="sm">
              {t('shell.dockerDown')}
            </Text>
            <Button color="red" loading={startDocker.isPending} onClick={() => startDocker.mutate({})}>
              {t('shell.start')}
            </Button>
          </Group>
        </Alert>
      )}
      {coreRestartedAt && dismissed !== coreRestartedAt && (
        <Alert color="orange" radius={0} py={6} withCloseButton onClose={() => setDismissed(coreRestartedAt)}>
          <Text size="sm">
            {t('shell.coreRestarted', { time: fmtTime(coreRestartedAt) })}
          </Text>
        </Alert>
      )}
      <UpdateBanner />
      <Box className={classes.main}>
        <ErrorBoundary resetKey={loc.pathname} scope="page">
          <Outlet />
        </ErrorBoundary>
      </Box>
      <AppFooter />
    </Box>
  );
}
