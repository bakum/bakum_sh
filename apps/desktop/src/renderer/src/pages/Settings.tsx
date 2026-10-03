import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import YAML from 'yaml';
import { Alert, Badge, Box, Button, Card, Code, Container, Group, Stack, Switch, Table, Tabs, Text, TextInput, Title } from '@mantine/core';
import { EditionBadge, EditionLine } from '../components/EditionBadge';
import { useBm, useBmMutation } from '../lib/query';
import { isMac } from '../lib/bm';
import { YamlEditor } from '../components/YamlEditor';
import { YamlForm, type FieldDef, type FieldGroup } from '../components/YamlForm';
import { DeleteProjectButton } from '../components/dialogs/DeleteProject';
import { ProjectExportMenu } from '../components/dialogs/ProjectExport';
import { PresetsCard } from '../components/PresetsCard';
import { MigratePostgresCard } from '../components/dialogs/MigratePostgres';
import { UpdatesCard } from '../components/UpdatesCard';
import { LANG_NAMES, LANGS } from '@bm/shared';
import { t, tx } from '../i18n';

const STAGE_NAMES = { production: 'Production', development: 'Development' } as const;

function stageFields(stage: keyof typeof STAGE_NAMES): FieldDef[] {
  const p = (k: string) => ['stages', stage, k];
  const inh = t('sf.inherit');
  return [
    { path: p('database'), label: t('field.database'), type: 'text', inherit: inh, description: stage === 'production' ? 'backup' : t('sf.dbHint') },
    { path: p('onNewCommit'), label: t('field.onNewCommit'), type: 'select', options: ['none', 'update', 'new'], inherit: inh },
    {
      path: p('updateModules'),
      label: t('sf.updateModules'),
      type: 'select',
      options: ['changed', 'version-bumped', 'all'],
      inherit: inh,
      description: t('sf.updateModulesHint'),
    },
    { path: p('install'), label: t('sf.install'), type: 'select', options: ['my', 'roots', 'full'], inherit: inh },
    { path: p('withDemo'), label: t('field.withDemo'), type: 'switch' },
    {
      path: p('cloneMethod'),
      label: t('field.cloneMethod'),
      type: 'select',
      options: ['template', 'dump'],
      inherit: inh,
      description: t('sf.cloneMethodHint'),
    },
    { path: p('buildOnAdd'), label: t('sf.buildOnAdd'), type: 'switch' },
    { path: p('protected'), label: t('field.protected'), type: 'switch' },
    { path: p('deleteWithRemote'), label: t('field.deleteWithRemote'), type: 'switch', description: t('sf.deleteWithRemoteHint') },
    { path: p('onForcePush'), label: 'Force-push', type: 'select', options: ['pause', 'new'], inherit: inh },
    { path: p('idleStopHours'), label: t('field.idleStopHours'), type: 'number', description: t('sf.idleHint') },
    { path: p('dropAfterDays'), label: t('sf.dropAfterDays'), type: 'number', description: t('sf.dropHint') },
  ];
}

/** Project settings tabs; a function, so the labels follow the interface language. */
const projectTabs = (): Record<string, { label: string; groups: FieldGroup[]; stage?: string }> => ({
  repo: {
    label: t('tab.repo'),
    groups: [
      {
        fields: [
          { path: ['name'], label: t('set.projectName'), type: 'text' },
          { path: ['repo', 'url'], label: t('set.repoUrl'), type: 'text', description: t('set.repoUrlHint') },
          { path: ['repo', 'mirrorDir'], label: t('set.mirror'), type: 'text', description: t('set.mirrorHint') },
          { path: ['repo', 'localFolder'], label: t('set.localFolder'), type: 'text', nullable: true, description: t('set.localFolderHint') },
          { path: ['repo', 'remote'], label: 'Remote', type: 'text' },
          { path: ['repo', 'github'], label: 'GitHub (owner/repo)', type: 'text', nullable: true },
          { path: ['repo', 'fetchIntervalMin'], label: t('set.fetchEvery'), type: 'number', description: t('set.fetchManual') },
          { path: ['repo', 'worktreesDir'], label: t('set.worktrees'), type: 'text' },
          { path: ['repo', 'protectedBranches'], label: t('set.protectedBranches'), type: 'tags' },
          { path: ['repo', 'moduleRoots'], label: t('set.moduleRoots'), type: 'tags', description: t('set.wholeRepo') },
          { path: ['repo', 'modulesToInstall'], label: t('set.myModules'), type: 'text', nullable: true },
          { path: ['repo', 'issueUrl'], label: t('set.issueUrl'), type: 'text', nullable: true },
        ],
      },
      {
        title: t('set.naming'),
        description: t('set.namingHint'),
        fields: [
          { path: ['naming', 'slug'], label: 'Slug', type: 'text' },
          { path: ['naming', 'slugStrip'], label: t('set.slugStrip'), type: 'text', nullable: true },
          { path: ['naming', 'db'], label: t('set.dbName'), type: 'text' },
          { path: ['naming', 'host'], label: t('set.host'), type: 'text' },
          { path: ['naming', 'composeProject'], label: t('set.compose'), type: 'text' },
          { path: ['naming', 'parse'], label: t('set.parse'), type: 'text', nullable: true },
          { path: ['naming', 'branch', 'pattern'], label: t('set.branchPattern'), type: 'text' },
          { path: ['naming', 'branch', 'base'], label: t('set.branchBase'), type: 'text' },
        ],
      },
    ],
  },
  stages: {
    label: t('tab.stages'),
    groups: [
      {
        fields: [
          { path: ['production', 'branch'], label: t('set.prodBranch'), type: 'text' },
          { path: ['production', 'slug'], label: t('set.prodSlug'), type: 'text' },
          { path: ['autoAddBranches'], label: t('set.autoAdd'), type: 'select', options: ['none', 'rules', 'all'] },
        ],
      },
      { title: 'Production', fields: stageFields('production') },
      { title: 'Development', fields: stageFields('development') },
    ],
  },
  runtime: {
    label: t('tab.runtime'),
    groups: [
      {
        description: t('set.runtimeHint'),
        fields: [
          { path: ['runtime', 'image'], label: t('field.image'), type: 'text' },
          { path: ['runtime', 'odooVersion'], label: t('set.odooVersion'), type: 'text' },
          { path: ['runtime', 'network'], label: t('set.network'), type: 'text' },
          { path: ['runtime', 'repoMount'], label: t('set.repoMount'), type: 'text' },
          { path: ['runtime', 'env'], label: t('field.env'), type: 'keyvalue' },
          { path: ['runtime', 'command'], label: t('set.command'), type: 'tags' },
          { path: ['runtime', 'filestore', 'hostDir'], label: t('set.fsHost'), type: 'text' },
          { path: ['runtime', 'filestore', 'containerDir'], label: t('set.fsContainer'), type: 'text' },
          { path: ['runtime', 'filestore', 'copy'], label: t('field.filestoreCopy'), type: 'select', options: ['hardlink', 'copy'] },
          { path: ['runtime', 'debug', 'containerPort'], label: t('set.debugPort'), type: 'number' },
          { path: ['runtime', 'healthcheck', 'path'], label: t('set.hcPath'), type: 'text' },
          { path: ['runtime', 'healthcheck', 'timeoutSec'], label: t('set.hcTimeout'), type: 'number' },
          { path: ['runtime', 'composeTemplate'], label: t('set.composeTemplate'), type: 'text', nullable: true, description: t('set.composeTemplateHint') },
        ],
      },
    ],
  },
  postgres: {
    label: 'Postgres',
    groups: [
      {
        fields: [
          { path: ['postgres', 'mode'], label: t('set.pgMode'), type: 'select', options: ['external', 'managed'], description: t('set.pgModeHint') },
          { path: ['postgres', 'image'], label: t('set.pgImage'), type: 'text' },
          { path: ['postgres', 'host'], label: t('set.pgHost'), type: 'text' },
          { path: ['postgres', 'port'], label: t('set.pgPort'), type: 'number' },
          { path: ['postgres', 'internalHost'], label: t('set.pgInternal'), type: 'text' },
          { path: ['postgres', 'user'], label: t('set.pgUser'), type: 'text' },
          { path: ['postgres', 'password'], label: t('set.pgPassword'), type: 'password', description: t('set.pgPasswordHint') },
          { path: ['postgres', 'protectedDbs'], label: t('set.protectedDbs'), type: 'tags' },
          { path: ['postgres', 'protectedContainers'], label: t('set.protectedContainers'), type: 'tags' },
        ],
      },
    ],
  },
  data: {
    label: t('tab.data'),
    groups: [
      {
        fields: [
          { path: ['production', 'backups', 'dir'], label: t('set.backupsDir'), type: 'text', nullable: true },
          { path: ['production', 'backups', 'pattern'], label: t('set.pattern'), type: 'text', description: t('set.patternHint') },
          { path: ['production', 'backups', 'pick'], label: t('set.pick'), type: 'select', options: ['latest', 'manual'] },
          { path: ['production', 'backups', 'autoImport'], label: t('set.autoImport'), type: 'switch', description: t('set.autoImportHint') },
          { path: ['production', 'postRestore', 'sql'], label: t('set.postRestoreSql'), type: 'tags' },
          { path: ['production', 'postRestore', 'verifySql'], label: t('set.verifySql'), type: 'textarea', nullable: true },
          { path: ['connect', 'adminPassword'], label: t('set.adminPassword'), type: 'text', nullable: true },
          { path: ['extraSql'], label: t('set.extraSql'), type: 'tags' },
        ],
      },
    ],
  },
  modules: {
    label: t('tab.modules'),
    groups: (['development', 'production'] as const).map((s) => ({
      title: t('set.testsOf', { stage: STAGE_NAMES[s] }),
      description: s === 'development' ? t('set.testsHint') : undefined,
      fields: [
        { path: ['stages', s, 'tests', 'mode'], label: t('set.testsMode'), type: 'select', options: ['none', 'changed', 'my'], inherit: t('sf.inherit') },
        { path: ['stages', s, 'tests', 'tags'], label: '--test-tags', type: 'text', description: t('set.testTagsHint') },
        { path: ['stages', s, 'tests', 'extraArgs'], label: t('set.extraArgs'), type: 'tags' },
        { path: ['stages', s, 'tests', 'failBuild'], label: t('field.failBuild'), type: 'switch', description: t('set.failBuildHint') },
      ],
    })),
  },
  mails: {
    label: t('tab.mails'),
    stage: t('form.postponed'),
    groups: [
      {
        description: t('set.mailsHint'),
        fields: [{ path: ['stages', 'development', 'mails', 'enabled'], label: t('set.mailpitDev'), type: 'switch', stage: 'postponed' }],
      },
    ],
  },
});

/** Settings (spec 8.11): project tabs with forms, full YAML, application settings. */
export function SettingsPage() {
  const { pid, tab } = useParams();
  const nav = useNavigate();
  const isApp = !pid;
  const active = isApp ? 'app' : (tab ?? 'repo');
  const project = useBm('projects.get', { projectId: pid ?? '' }, { enabled: !!pid });
  const appCfg = useBm('config.get', { level: 'app' });
  const update = useBmMutation('projects.update', { success: t('set.projectSaved') });
  const putApp = useBmMutation('config.put', { success: t('set.appSaved') });
  const setEnabled = useBmMutation('projects.setEnabled');
  const [yaml, setYaml] = useState('');
  useEffect(() => {
    if (project.data) setYaml(project.data.yaml);
  }, [project.data]);

  const saveProject = (text: string) => update.mutateAsync({ projectId: pid!, yaml: text });
  // Within a project the «Приложение» tab keeps the project route, so its tabs and the header's project stay.
  const go = (tab: string | null) => nav(pid ? `/projects/${pid}/settings/${tab}` : '/settings/app');
  const tabs = projectTabs();

  return (
    <Container size="xl" py="md">
      <Stack>
        <Group justify="space-between">
          <Group gap="sm">
            <Title order={3}>{isApp ? t('set.appTitle') : t('set.projectTitle', { name: project.data?.summary.name ?? '' })}</Title>
            {!isApp && <EditionBadge edition={project.data?.summary.edition} />}
          </Group>
          {project.data && (
            <Group>
              <Switch
                label={t('set.enabled')}
                checked={project.data.summary.enabled}
                onChange={(e) => setEnabled.mutate({ projectId: pid!, enabled: e.currentTarget.checked })}
              />
              <ProjectExportMenu projectId={pid!} projectName={project.data.summary.name} />
              <DeleteProjectButton projectId={pid!} />
            </Group>
          )}
        </Group>
        {project.data?.summary.legacy && (
          <Alert color="red" title={t('set.legacyTitle')}>
            {t('set.legacy', { path: project.data.summary.repoPath })}
          </Alert>
        )}
        {project.data?.summary.configError && (
          <Alert color="red" title={t('set.configError')}>
            {project.data.summary.configError}
          </Alert>
        )}
        <Tabs value={active} onChange={go} keepMounted={false}>
          <Tabs.List>
            {!isApp &&
              Object.entries(tabs).map(([k, tb]) => (
                <Tabs.Tab key={k} value={k} rightSection={tb.stage ? <Badge size="xs" variant="light" color="gray">{tb.stage}</Badge> : null}>
                  {tb.label}
                </Tabs.Tab>
              ))}
            {!isApp && <Tabs.Tab value="rules">{t('tab.rules')}</Tabs.Tab>}
            {!isApp && <Tabs.Tab value="agents">{t('tab.agents')}</Tabs.Tab>}
            {!isApp && (
              <Tabs.Tab value="hooks" rightSection={<Badge size="xs" variant="light" color="gray">{t('form.postponed')}</Badge>}>
                {t('tab.hooks')}
              </Tabs.Tab>
            )}
            {!isApp && <Tabs.Tab value="yaml">YAML</Tabs.Tab>}
            <Tabs.Tab value="app">{t('tab.app')}</Tabs.Tab>
          </Tabs.List>

          {!isApp &&
            project.data &&
            Object.entries(tabs).map(([k, tb]) => (
              <Tabs.Panel key={k} value={k} pt="md">
                <Card withBorder>
                  {k === 'runtime' && (
                    <Box mb="md">
                      <EditionLine edition={project.data.summary.edition} />
                    </Box>
                  )}
                  {k === 'runtime' && !project.data.summary.legacy && (
                    <RuntimeBuildCard projectId={pid!} yaml={project.data.yaml} build={project.data.config.runtime.build} image={project.data.config.runtime.image} onSave={saveProject} />
                  )}
                  {k === 'postgres' && !project.data.summary.legacy && (
                    <MigratePostgresCard projectId={pid!} external={project.data.config.postgres.mode === 'external'} />
                  )}
                  <YamlForm text={project.data.yaml} groups={tb.groups} onSave={saveProject} saving={update.isPending} defaults={project.data.config} />
                </Card>
              </Tabs.Panel>
            ))}

          {!isApp && project.data && (
            <Tabs.Panel value="rules" pt="md">
              <Card withBorder>
                <Stack>
                  <Text size="sm" c="dimmed">
                    {t('set.rulesHint')}
                  </Text>
                  <Table striped withTableBorder>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>#</Table.Th>
                        <Table.Th>match</Table.Th>
                        <Table.Th>{t('set.stage')}</Table.Th>
                        <Table.Th>{t('set.overrides')}</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {project.data.config.branchRules.map((r, i) => (
                        <Table.Tr key={i}>
                          <Table.Td>{i + 1}</Table.Td>
                          <Table.Td>{JSON.stringify(r.match)}</Table.Td>
                          <Table.Td>{r.stage}</Table.Td>
                          <Table.Td>{r.overrides ? YAML.stringify(r.overrides) : '—'}</Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                  <Text size="sm">
                    {tx('set.autoAddMode', { mode: project.data.config.autoAddBranches }, { b: (x) => <b>{x}</b> })}
                  </Text>
                </Stack>
              </Card>
            </Tabs.Panel>
          )}

          {!isApp && project.data && (
            <Tabs.Panel value="agents" pt="md">
              <AgentSkillCard projectId={pid!} />
            </Tabs.Panel>
          )}

          {!isApp && project.data && (
            <Tabs.Panel value="hooks" pt="md">
              <Alert color="gray">
                {t('set.hooks')}
              </Alert>
            </Tabs.Panel>
          )}

          {!isApp && project.data && (
            <Tabs.Panel value="yaml" pt="md">
              <Stack>
                <Text size="sm" c="dimmed">
                  {t('set.yamlHint', { path: project.data.summary.configPath })}
                </Text>
                <Box style={{ border: '1px solid var(--mantine-color-default-border)' }}>
                  <YamlEditor path={`project-${pid}`} schema="project" value={yaml} onChange={setYaml} height="calc(100vh - 300px)" />
                </Box>
                <Group justify="flex-end">
                  <Button variant="default" onClick={() => setYaml(project.data!.yaml)}>
                    {t('common.revert')}
                  </Button>
                  <Button loading={update.isPending} disabled={yaml === project.data.yaml} onClick={() => void saveProject(yaml)}>
                    {t('common.save')}
                  </Button>
                </Group>
              </Stack>
            </Tabs.Panel>
          )}

          <Tabs.Panel value="app" pt="md">
            {appCfg.data && <AppSettings text={appCfg.data.yaml} defaults={appCfg.data.value} onSave={(text) => putApp.mutateAsync({ level: 'app', yaml: text })} saving={putApp.isPending} />}
          </Tabs.Panel>
        </Tabs>
      </Stack>
    </Container>
  );
}

/**
 * runtime.build (D46): the app builds the Odoo image from a Dockerfile and tags it runtime.image. The tag must not name
 * an image the app did not build (Core refuses it), so a project tag is suggested.
 */
function RuntimeBuildCard({
  projectId,
  yaml,
  build,
  image,
  onSave,
}: {
  projectId: string;
  yaml: string;
  build: { context: string; dockerfile: string } | null;
  image: string;
  onSave: (text: string) => Promise<unknown>;
}) {
  const [context, setContext] = useState(build?.context ?? '');
  const [dockerfile, setDockerfile] = useState(build?.dockerfile ?? 'Dockerfile');
  const [tag, setTag] = useState(image);
  const buildNow = useBmMutation('projects.buildImage', { success: t('img.queued') });
  const jobs = useBm('jobs.list', { projectId, limit: 30 }, { refetchInterval: 3000 });
  const job = (jobs.data ?? []).find((j) => j.type === 'build_image');
  const [showLog, setShowLog] = useState(false);
  const jobLog = useBm('jobs.log', { jobId: job?.id ?? 0, tail: 80 }, { enabled: !!job && showLog, refetchInterval: 3000 });
  useEffect(() => {
    setContext(build?.context ?? '');
    setDockerfile(build?.dockerfile ?? 'Dockerfile');
    setTag(image);
  }, [build, image]);
  const save = (next: { context: string; dockerfile: string } | null) => {
    const doc = YAML.parseDocument(yaml);
    doc.setIn(['runtime', 'build'], next);
    if (next) doc.setIn(['runtime', 'image'], tag.trim());
    return onSave(doc.toString());
  };
  const suggested = `bm-${projectId}-odoo:latest`;
  return (
    <Card withBorder mb="md" data-testid="runtime-build">
      <Stack gap="xs">
        <Group justify="space-between">
          <Text fw={600}>{t('img.title')}</Text>
          <Badge color={build ? 'teal' : 'gray'} variant="light">
            {t(build ? 'img.on' : 'img.off')}
          </Badge>
        </Group>
        <Text size="xs" c="dimmed">
          {t('img.hint')}
        </Text>
        <Group align="flex-end" gap="xs">
          <TextInput label={t('img.context')} w={420} value={context} onChange={(e) => setContext(e.currentTarget.value)} />
          <Button
            variant="default"
            onClick={async () => {
              const d = await window.bm.desktop.selectDirectory(t('img.pickContext'));
              if (d) setContext(d);
            }}
          >
            {t('repo.choose')}
          </Button>
          <TextInput label="Dockerfile" w={180} value={dockerfile} onChange={(e) => setDockerfile(e.currentTarget.value)} />
        </Group>
        <Group align="flex-end" gap="xs">
          <TextInput label={t('img.tag')} w={420} value={tag} onChange={(e) => setTag(e.currentTarget.value)} />
          {tag !== suggested && (
            <Button variant="subtle" onClick={() => setTag(suggested)}>
              {suggested}
            </Button>
          )}
        </Group>
        <Group gap="xs">
          <Button disabled={!context.trim() || !dockerfile.trim() || !tag.trim()} onClick={() => void save({ context: context.trim(), dockerfile: dockerfile.trim() })}>
            {build ? t('common.save') : t('img.enable')}
          </Button>
          {build && (
            <>
              <Button variant="default" loading={buildNow.isPending} onClick={() => buildNow.mutate({ projectId })}>
                {t('img.buildNow')}
              </Button>
              <Button variant="subtle" color="red" onClick={() => void save(null)}>
                {t('img.disable')}
              </Button>
            </>
          )}
        </Group>
        {job && (
          <Stack gap={4}>
            <Group gap="xs">
              <Text size="sm">{t('img.lastManual')}</Text>
              <Badge color={job.status === 'success' ? 'teal' : job.status === 'failed' ? 'red' : 'orange'} variant="light" data-testid="image-job-status">
                {job.status}
              </Badge>
              <Button size="compact-xs" variant="subtle" onClick={() => setShowLog((v) => !v)}>
                {t(showLog ? 'img.hideLog' : 'img.log')}
              </Button>
            </Group>
            {job.error && (
              <Text size="sm" c="red" style={{ whiteSpace: 'pre-wrap' }}>
                {job.error}
              </Text>
            )}
            {showLog && <Code block>{(jobLog.data?.lines ?? []).join('\n') || '…'}</Code>}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}

const SKILL_COLOR: Record<string, string> = { none: 'gray', current: 'teal', outdated: 'orange', modified: 'red', foreign: 'red' };
const skillState = (s: string): { text: string; color: string } => ({
  text: s in SKILL_COLOR ? t(`skill.${s as 'none'}`) : s,
  color: SKILL_COLOR[s] ?? 'gray',
});

/**
 * Skill for Claude Code / Cursor (D52): the app writes it from the project settings into `<folder>/.claude/skills`,
 * so assistants know the builds, labels and what only the app may do.
 */
function AgentSkillCard({ projectId }: { projectId: string }) {
  const [dir, setDir] = useState<string | null>(null);
  const [inGit, setInGit] = useState(false);
  const [showText, setShowText] = useState(false);
  const status = useBm('agents.skillStatus', { projectId, ...(dir ? { dir } : {}) });
  const install = useBmMutation('agents.installSkill', { success: t('skill.written') });
  const s = status.data;
  const target = dir ?? s?.dir ?? null;
  const st = skillState(s?.state ?? 'none');
  const risky = s?.state === 'modified' || s?.state === 'foreign';
  const choices = [...new Set([...(s?.suggestedDirs ?? []), ...(target ? [target] : [])])];
  return (
    <Card withBorder data-testid="agent-skill">
      <Stack gap="sm">
        <Group justify="space-between">
          <Text fw={600}>{t('skill.title')}</Text>
          <Badge color={st.color} variant="light" data-testid="skill-state">
            {st.text}
            {s?.installedVersion ? ` · ${s.installedVersion}` : ''}
          </Badge>
        </Group>
        <Text size="sm" c="dimmed">
          {tx('skill.hint', { file: `.claude/skills/${s?.name ?? '…'}/SKILL.md` }, { code: (x: ReactNode) => <Code>{x}</Code> })}
        </Text>
        <Group align="flex-end" gap="xs">
          <TextInput label={t('skill.folder')} w={420} value={target ?? ''} onChange={(e) => setDir(e.currentTarget.value || null)} />
          <Button
            variant="default"
            onClick={async () => {
              const d = await window.bm.desktop.selectDirectory(t('skill.pickFolder'));
              if (d) setDir(d);
            }}
          >
            {t('repo.choose')}
          </Button>
          {choices
            .filter((c) => c !== target)
            .map((c) => (
              <Button key={c} variant="subtle" onClick={() => setDir(c)}>
                {c}
              </Button>
            ))}
        </Group>
        {s?.path && (
          <Text size="xs" c="dimmed">
            {t('skill.file')} <Code>{s.path}</Code>
          </Text>
        )}
        {risky && (
          <Alert color="red">
            {s?.state === 'modified'
              ? t('skill.modifiedWarn')
              : t('skill.foreignWarn')}
          </Alert>
        )}
        {inGit && (
          <Alert color="blue">
            {t('skill.inGit')}
          </Alert>
        )}
        <Group gap="xs">
          <Button
            color={risky ? 'red' : undefined}
            disabled={!target || s?.state === 'current'}
            loading={install.isPending}
            onClick={async () => {
              const r = await install.mutateAsync({ projectId, dir: target!, overwrite: risky });
              setInGit(r.inGit);
              setDir(null);
            }}
          >
            {s?.state === 'none' ? t('skill.install') : risky ? t('skill.overwrite') : t('skill.update')}
          </Button>
          <Button variant="subtle" onClick={() => setShowText((v) => !v)}>
            {t(showText ? 'skill.hideText' : 'skill.showText')}
          </Button>
        </Group>
        {showText && s && (
          <Code block style={{ maxHeight: 480, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
            {s.content}
          </Code>
        )}
      </Stack>
    </Card>
  );
}

function AppSettings({ text, defaults, onSave, saving }: { text: string; defaults: unknown; onSave: (t: string) => Promise<unknown>; saving: boolean }) {
  const [yaml, setYaml] = useState(text);
  useEffect(() => setYaml(text), [text]);
  const groups: FieldGroup[] = [
    {
      title: t('app.general'),
      fields: [
        // D69: the window switches as soon as the file is saved; Core and main follow the same setting.
        { path: ['language'], label: t('app.language'), type: 'select', options: [...LANGS], optionLabels: LANG_NAMES, description: t('app.languageHint') },
      ],
    },
    {
      title: t('app.builds'),
      fields: [
        { path: ['proxyPort'], label: t('app.traefikPort'), type: 'number', description: t('app.traefikPortHint') },
        { path: ['limits', 'maxParallelBuilds'], label: t('app.parallel'), type: 'number' },
        { path: ['limits', 'maxRunningBuilds'], label: t('app.running'), type: 'number' },
        { path: ['limits', 'enforce'], label: t('app.enforce'), type: 'switch' },
        { path: ['limits', 'minFreeDiskGb'], label: t('app.minDisk'), type: 'number' },
        { path: ['dataDir'], label: t('app.dataDir'), type: 'text', description: t('app.dataDirHint') },
      ],
    },
    {
      title: t('app.desktop'),
      fields: [
        { path: ['desktop', 'closeToTray'], label: t('app.closeToTray'), type: 'switch' },
        { path: ['desktop', 'startMinimized'], label: t('app.startMinimized'), type: 'switch' },
        { path: ['desktop', 'autostart'], label: t(isMac ? 'app.autostartMac' : 'app.autostartWin'), type: 'switch' },
        { path: ['desktop', 'editor'], label: t('app.editor'), type: 'text', description: t('app.editorHint') },
        // macOS always opens Terminal.app (D67).
        ...(isMac ? [] : [{ path: ['desktop', 'terminal'], label: t('app.terminal'), type: 'select', options: ['wt', 'git-bash', 'cmd'] } satisfies FieldDef]),
        {
          path: ['desktop', 'dockerDesktopExe'],
          label: isMac ? 'Docker Desktop' : 'Docker Desktop.exe',
          type: 'text',
          description: isMac ? t('app.dockerAppHint') : undefined,
        },
        { path: ['desktop', 'gh'], label: 'gh CLI', type: 'text' },
      ],
    },
    {
      title: t('app.updates'),
      fields: [
        { path: ['updates', 'checkOnStart'], label: t('app.checkOnStart'), type: 'switch' },
        { path: ['updates', 'includePrerelease'], label: t('app.prerelease'), type: 'switch' },
        { path: ['updates', 'repository'], label: t('app.repository'), type: 'text', description: 'owner/repo' },
      ],
    },
    {
      title: t(isMac ? 'app.notificationsMac' : 'app.notificationsWin'),
      fields: [
        { path: ['desktop', 'notifications', 'buildReady'], label: t('app.nReady'), type: 'switch' },
        { path: ['desktop', 'notifications', 'buildFailed'], label: t('app.nFailed'), type: 'switch' },
        { path: ['desktop', 'notifications', 'testsFailed'], label: t('app.nTests'), type: 'switch' },
        { path: ['desktop', 'notifications', 'newBackup'], label: t('app.nBackup'), type: 'switch' },
        { path: ['desktop', 'notifications', 'lowDisk'], label: t('app.nDisk'), type: 'switch' },
        { path: ['desktop', 'notifications', 'buildExpired'], label: t('app.nExpired'), type: 'switch' },
        { path: ['desktop', 'notifications', 'branchRemoved'], label: t('app.nRemoved'), type: 'switch' },
        { path: ['desktop', 'notifications', 'skillOutdated'], label: t('app.nSkill'), type: 'switch' },
      ],
    },
  ];
  return (
    <Stack>
      <UpdatesCard />
      <PresetsCard />
      <Card withBorder>
        <YamlForm text={text} groups={groups} onSave={onSave} saving={saving} defaults={defaults} />
      </Card>
      <Card withBorder>
        <Stack>
          <Text fw={600}>app.yaml</Text>
          <YamlEditor path="app" schema="app" value={yaml} onChange={setYaml} height={320} />
          <Group justify="flex-end">
            <Button loading={saving} disabled={yaml === text} onClick={() => void onSave(yaml)}>
              {t('common.save')}
            </Button>
          </Group>
        </Stack>
      </Card>
    </Stack>
  );
}
