import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import YAML from 'yaml';
import { Alert, Badge, Box, Button, Card, Container, Group, Stack, Switch, Table, Tabs, Text, Title } from '@mantine/core';
import { EditionBadge, EditionLine } from '../components/EditionBadge';
import { useBm, useBmMutation } from '../lib/query';
import { YamlEditor } from '../components/YamlEditor';
import { YamlForm, type FieldDef, type FieldGroup } from '../components/YamlForm';
import { DeleteProjectButton } from '../components/dialogs/DeleteProject';
import { MigratePostgresCard } from '../components/dialogs/MigratePostgres';
import { UpdatesCard } from '../components/UpdatesCard';

const STAGE_NAMES = { production: 'Production', development: 'Development' } as const;

function stageFields(stage: keyof typeof STAGE_NAMES): FieldDef[] {
  const p = (k: string) => ['stages', stage, k];
  const inh = 'значение по умолчанию (odoo.sh)';
  return [
    { path: p('database'), label: 'База данных', type: 'text', inherit: inh, description: stage === 'production' ? 'backup' : 'fresh | copy:production | copy:<ветка>' },
    { path: p('onNewCommit'), label: 'Новый коммит', type: 'select', options: ['none', 'update', 'new'], inherit: inh },
    {
      path: p('updateModules'),
      label: 'Обновлять модули (-u)',
      type: 'select',
      options: ['changed', 'version-bumped', 'all'],
      inherit: inh,
      description: 'version-bumped — только модули с новой версией в манифесте (как odoo.sh)',
    },
    { path: p('install'), label: 'Установка для fresh', type: 'select', options: ['my', 'roots', 'full'], inherit: inh },
    { path: p('withDemo'), label: 'Демо-данные (fresh)', type: 'switch' },
    {
      path: p('cloneMethod'),
      label: 'Копирование БД',
      type: 'select',
      options: ['template', 'dump'],
      inherit: inh,
      description: 'template — быстро, источник останавливается на время копии; dump — pg_dump без остановки, медленнее',
    },
    { path: p('buildOnAdd'), label: 'Собирать при добавлении ветки', type: 'switch' },
    { path: p('protected'), label: 'Защита от удаления', type: 'switch' },
    { path: p('onForcePush'), label: 'Force-push', type: 'select', options: ['pause', 'new'], inherit: inh },
    { path: p('idleStopHours'), label: 'Остановка без активности, ч', type: 'number', stage: 'этап 2' },
    { path: p('dropAfterDays'), label: 'Отбросить через, дней', type: 'number', stage: 'этап 2' },
  ];
}

const projectTabs: Record<string, { label: string; groups: FieldGroup[]; stage?: string }> = {
  repo: {
    label: 'Репозиторий',
    groups: [
      {
        fields: [
          { path: ['name'], label: 'Название проекта', type: 'text' },
          { path: ['repo', 'url'], label: 'Адрес репозитория', type: 'text', description: 'откуда берётся код сборок' },
          { path: ['repo', 'mirrorDir'], label: 'Копия приложения', type: 'text', description: 'своя копия репозитория приложения, в ней не работают' },
          { path: ['repo', 'localFolder'], label: 'Ваша папка с клоном', type: 'text', nullable: true, description: 'подсказка для «своей папки» у веток Development' },
          { path: ['repo', 'remote'], label: 'Remote', type: 'text' },
          { path: ['repo', 'github'], label: 'GitHub (owner/repo)', type: 'text', nullable: true },
          { path: ['repo', 'fetchIntervalMin'], label: 'Fetch каждые, мин', type: 'number', description: '0 — только вручную' },
          { path: ['repo', 'worktreesDir'], label: 'Папка веток (worktree)', type: 'text' },
          { path: ['repo', 'protectedBranches'], label: 'Защищённые ветки', type: 'tags' },
          { path: ['repo', 'moduleRoots'], label: 'Корни модулей', type: 'tags', description: 'пусто — весь репозиторий' },
          { path: ['repo', 'modulesToInstall'], label: 'Файл «моих» модулей', type: 'text', nullable: true },
          { path: ['repo', 'issueUrl'], label: 'Ссылка на задачу', type: 'text', nullable: true },
        ],
      },
      {
        title: 'Имена ресурсов',
        description: 'Переменные: {project} {branch} {slug} {slug_} {build} {stage} {issue} {type}. Имена БД разных проектов не могут пересекаться.',
        fields: [
          { path: ['naming', 'slug'], label: 'Slug', type: 'text' },
          { path: ['naming', 'slugStrip'], label: 'Убрать из slug (regex)', type: 'text', nullable: true },
          { path: ['naming', 'db'], label: 'Имя БД', type: 'text' },
          { path: ['naming', 'host'], label: 'Хост сборки', type: 'text' },
          { path: ['naming', 'composeProject'], label: 'Compose-проект', type: 'text' },
          { path: ['naming', 'parse'], label: 'Разбор имени ветки (regex)', type: 'text', nullable: true },
          { path: ['naming', 'branch', 'pattern'], label: 'Шаблон новой ветки (Fork)', type: 'text' },
          { path: ['naming', 'branch', 'base'], label: 'База новой ветки', type: 'text' },
        ],
      },
    ],
  },
  stages: {
    label: 'Стадии и правила',
    groups: [
      {
        fields: [
          { path: ['production', 'branch'], label: 'Ветка Production', type: 'text' },
          { path: ['production', 'slug'], label: 'Slug Production', type: 'text' },
          { path: ['autoAddBranches'], label: 'Добавлять новые ветки', type: 'select', options: ['none', 'rules', 'all'] },
        ],
      },
      { title: 'Production', fields: stageFields('production') },
      { title: 'Development', fields: stageFields('development') },
    ],
  },
  runtime: {
    label: 'Рантайм',
    groups: [
      {
        description: 'Изменение образа, команды, монтирований или переменных помечает живые сборки «конфигурация изменилась».',
        fields: [
          { path: ['runtime', 'image'], label: 'Образ Odoo', type: 'text' },
          { path: ['runtime', 'odooVersion'], label: 'Версия Odoo', type: 'text' },
          { path: ['runtime', 'network'], label: 'Docker-сеть', type: 'text' },
          { path: ['runtime', 'repoMount'], label: 'Путь репозитория в контейнере', type: 'text' },
          { path: ['runtime', 'env'], label: 'Переменные окружения', type: 'keyvalue' },
          { path: ['runtime', 'command'], label: 'Команда контейнера', type: 'tags' },
          { path: ['runtime', 'filestore', 'hostDir'], label: 'Filestore на хосте', type: 'text' },
          { path: ['runtime', 'filestore', 'containerDir'], label: 'Filestore в контейнере', type: 'text' },
          { path: ['runtime', 'filestore', 'copy'], label: 'Копирование filestore', type: 'select', options: ['hardlink', 'copy'] },
          { path: ['runtime', 'debug', 'containerPort'], label: 'Порт debugpy в контейнере', type: 'number' },
          { path: ['runtime', 'healthcheck', 'path'], label: 'Healthcheck, путь', type: 'text' },
          { path: ['runtime', 'healthcheck', 'timeoutSec'], label: 'Healthcheck, таймаут, с', type: 'number' },
          { path: ['runtime', 'build'], label: 'Сборка образа (runtime.build)', type: 'text', stage: 'этап 2' },
          { path: ['runtime', 'composeTemplate'], label: 'Свой шаблон compose', type: 'text', stage: 'этап 3' },
        ],
      },
    ],
  },
  postgres: {
    label: 'Postgres',
    groups: [
      {
        fields: [
          {
            path: ['postgres', 'mode'],
            label: 'Режим',
            type: 'select',
            options: ['external', 'managed'],
            description: 'external — существующий Postgres; managed — свой контейнер приложения bm-<проект>-db',
          },
          { path: ['postgres', 'image'], label: 'Образ (managed)', type: 'text' },
          { path: ['postgres', 'host'], label: 'Хост (с машины)', type: 'text' },
          { path: ['postgres', 'port'], label: 'Порт (с машины)', type: 'number' },
          { path: ['postgres', 'internalHost'], label: 'Хост в Docker-сети', type: 'text' },
          { path: ['postgres', 'user'], label: 'Пользователь', type: 'text' },
          { path: ['postgres', 'password'], label: 'Пароль', type: 'password', description: 'хранится только в файле проекта и в Core' },
          { path: ['postgres', 'protectedDbs'], label: 'Защищённые БД', type: 'tags' },
          { path: ['postgres', 'protectedContainers'], label: 'Защищённые контейнеры', type: 'tags' },
        ],
      },
    ],
  },
  data: {
    label: 'Данные (Production)',
    groups: [
      {
        fields: [
          { path: ['production', 'backups', 'dir'], label: 'Папка бэкапов прода', type: 'text', nullable: true },
          { path: ['production', 'backups', 'pattern'], label: 'Шаблон имени', type: 'text', description: 'бэкап Odoo *.zip или дамп pg_dump -Fc *.dump (без filestore)' },
          { path: ['production', 'backups', 'pick'], label: 'Выбор файла', type: 'select', options: ['latest', 'manual'] },
          {
            path: ['production', 'backups', 'autoImport'],
            label: 'Автоимпорт нового бэкапа',
            type: 'switch',
            description: 'новый файл в папке сразу собирается в зеркало прода; уведомление о новом бэкапе приходит всегда',
          },
          { path: ['production', 'postRestore', 'sql'], label: 'SQL после восстановления', type: 'tags' },
          { path: ['production', 'postRestore', 'verifySql'], label: 'Проверка (должна вернуть 0)', type: 'textarea', nullable: true },
          { path: ['connect', 'adminPassword'], label: 'Пароль admin в копиях БД', type: 'text', nullable: true },
          { path: ['extraSql'], label: 'Дополнительный SQL (local-tweaks)', type: 'tags' },
        ],
      },
    ],
  },
  modules: {
    label: 'Модули и тесты',
    groups: (['development', 'production'] as const).map((s) => ({
      title: `Тесты ${STAGE_NAMES[s]}`,
      description:
        s === 'development'
          ? 'Какие модули обновлять — в «Стадии и правила». changed — изменённые модули (для чистой БД — изменённые относительно ветки Production), my — «мои» модули, none — без тестов. Чистая БД тестируется при установке модулей, копия — на временной копии <БД>_test.'
          : undefined,
      fields: [
        { path: ['stages', s, 'tests', 'mode'], label: 'Какие модули тестировать', type: 'select', options: ['none', 'changed', 'my'], inherit: 'значение по умолчанию (odoo.sh)' },
        { path: ['stages', s, 'tests', 'tags'], label: '--test-tags', type: 'text', description: 'шаблон на модуль, по умолчанию /{module}' },
        { path: ['stages', s, 'tests', 'extraArgs'], label: 'Доп. аргументы Odoo', type: 'tags' },
        { path: ['stages', s, 'tests', 'failBuild'], label: 'Падение тестов роняет сборку', type: 'switch', description: 'сборка не поднимается, живой остаётся предыдущая' },
      ],
    })),
  },
  mails: {
    label: 'Почта',
    stage: 'отложено',
    groups: [
      {
        description:
          'Mailpit в сборках отложен (docs/decisions.md D43). Письма из сборок наружу не уходят: почтовые серверы копий прода выключены нейтрализацией, в чистых БД их нет, а без сервера Odoo пытается отправить на localhost:25 внутри контейнера и получает ошибку. Не включайте почтовый сервер вручную в сборке с копией прода: письма уйдут настоящим адресатам.',
        fields: [
          { path: ['stages', 'development', 'mails', 'enabled'], label: 'Mailpit в Development', type: 'switch', stage: 'отложено' },
        ],
      },
    ],
  },
};

/** Settings (spec 8.11): project tabs with forms, full YAML, application settings. */
export function SettingsPage() {
  const { pid, tab } = useParams();
  const nav = useNavigate();
  const isApp = !pid;
  const active = isApp ? 'app' : (tab ?? 'repo');
  const project = useBm('projects.get', { projectId: pid ?? '' }, { enabled: !!pid });
  const appCfg = useBm('config.get', { level: 'app' });
  const update = useBmMutation('projects.update', { success: 'Настройки проекта сохранены' });
  const putApp = useBmMutation('config.put', { success: 'Настройки приложения сохранены' });
  const setEnabled = useBmMutation('projects.setEnabled');
  const [yaml, setYaml] = useState('');
  useEffect(() => {
    if (project.data) setYaml(project.data.yaml);
  }, [project.data]);

  const saveProject = (text: string) => update.mutateAsync({ projectId: pid!, yaml: text });
  const go = (t: string | null) => nav(t === 'app' ? '/settings/app' : `/projects/${pid ?? ''}/settings/${t}`);

  return (
    <Container size="xl" py="md">
      <Stack>
        <Group justify="space-between">
          <Group gap="sm">
            <Title order={3}>{isApp ? 'Настройки приложения' : `Настройки проекта ${project.data?.summary.name ?? ''}`}</Title>
            {!isApp && <EditionBadge edition={project.data?.summary.edition} />}
          </Group>
          {project.data && (
            <Group>
              <Switch
                label="Проект включён (fetch и авто-сборки)"
                checked={project.data.summary.enabled}
                onChange={(e) => setEnabled.mutate({ projectId: pid!, enabled: e.currentTarget.checked })}
              />
              <DeleteProjectButton projectId={pid!} />
            </Group>
          )}
        </Group>
        {project.data?.summary.legacy && (
          <Alert color="red" title="Проект старой схемы">
            Приложение работало внутри вашего репозитория ({project.data.summary.repoPath}), поэтому Git мешал переключать ветки. Сборки и fetch для
            этого проекта отключены. Удалите проект кнопкой «Удалить проект…» (он удаляется полностью) и добавьте заново: код сборок будет браться с
            GitHub через копию приложения, а свою папку можно подключить у веток Development.
          </Alert>
        )}
        {project.data?.summary.configError && (
          <Alert color="red" title="Файл настроек содержит ошибку">
            {project.data.summary.configError}
          </Alert>
        )}
        <Tabs value={active} onChange={go} keepMounted={false}>
          <Tabs.List>
            {!isApp &&
              Object.entries(projectTabs).map(([k, t]) => (
                <Tabs.Tab key={k} value={k} rightSection={t.stage ? <Badge size="xs" variant="light" color="gray">{t.stage}</Badge> : null}>
                  {t.label}
                </Tabs.Tab>
              ))}
            {!isApp && <Tabs.Tab value="rules">Правила веток</Tabs.Tab>}
            {!isApp && (
              <Tabs.Tab value="hooks" rightSection={<Badge size="xs" variant="light" color="gray">отложено</Badge>}>
                Хуки
              </Tabs.Tab>
            )}
            {!isApp && <Tabs.Tab value="yaml">YAML</Tabs.Tab>}
            <Tabs.Tab value="app">Приложение</Tabs.Tab>
          </Tabs.List>

          {!isApp &&
            project.data &&
            Object.entries(projectTabs).map(([k, t]) => (
              <Tabs.Panel key={k} value={k} pt="md">
                <Card withBorder>
                  {k === 'runtime' && (
                    <Box mb="md">
                      <EditionLine edition={project.data.summary.edition} />
                    </Box>
                  )}
                  {k === 'postgres' && !project.data.summary.legacy && (
                    <MigratePostgresCard projectId={pid!} external={project.data.config.postgres.mode === 'external'} />
                  )}
                  <YamlForm text={project.data.yaml} groups={t.groups} onSave={saveProject} saving={update.isPending} />
                </Card>
              </Tabs.Panel>
            ))}

          {!isApp && project.data && (
            <Tabs.Panel value="rules" pt="md">
              <Card withBorder>
                <Stack>
                  <Text size="sm" c="dimmed">
                    Правила применяются сверху вниз, первое совпадение задаёт стадию. match — glob (* — любые символы), список или {'{ regex: … }'}. Редактируются во вкладке YAML.
                  </Text>
                  <Table striped withTableBorder>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>#</Table.Th>
                        <Table.Th>match</Table.Th>
                        <Table.Th>Стадия</Table.Th>
                        <Table.Th>Переопределения</Table.Th>
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
                    Режим добавления новых веток: <b>{project.data.config.autoAddBranches}</b>
                  </Text>
                </Stack>
              </Card>
            </Tabs.Panel>
          )}

          {!isApp && project.data && (
            <Tabs.Panel value="hooks" pt="md">
              <Alert color="gray">
                Хуки шагов сборки (before/after, SQL, odoo-shell, container, host) отложены (docs/decisions.md D44): раздел hooks в YAML
                принимается, но не выполняется.
              </Alert>
            </Tabs.Panel>
          )}

          {!isApp && project.data && (
            <Tabs.Panel value="yaml" pt="md">
              <Stack>
                <Text size="sm" c="dimmed">
                  {project.data.summary.configPath} — правка файла вручную тоже подхватывается автоматически. Пароль Postgres скрыт; «********» сохраняет прежний.
                </Text>
                <Box style={{ border: '1px solid var(--mantine-color-default-border)' }}>
                  <YamlEditor path={`project-${pid}`} schema="project" value={yaml} onChange={setYaml} height="calc(100vh - 300px)" />
                </Box>
                <Group justify="flex-end">
                  <Button variant="default" onClick={() => setYaml(project.data!.yaml)}>
                    Отменить
                  </Button>
                  <Button loading={update.isPending} disabled={yaml === project.data.yaml} onClick={() => void saveProject(yaml)}>
                    Сохранить
                  </Button>
                </Group>
              </Stack>
            </Tabs.Panel>
          )}

          <Tabs.Panel value="app" pt="md">
            {appCfg.data && <AppSettings text={appCfg.data.yaml} onSave={(t) => putApp.mutateAsync({ level: 'app', yaml: t })} saving={putApp.isPending} />}
          </Tabs.Panel>
        </Tabs>
      </Stack>
    </Container>
  );
}

function AppSettings({ text, onSave, saving }: { text: string; onSave: (t: string) => Promise<unknown>; saving: boolean }) {
  const [yaml, setYaml] = useState(text);
  useEffect(() => setYaml(text), [text]);
  const groups: FieldGroup[] = [
    {
      title: 'Сборки и ресурсы',
      fields: [
        { path: ['proxyPort'], label: 'Порт Traefik', type: 'number', description: '80, если свободен; иначе 8080' },
        { path: ['limits', 'maxParallelBuilds'], label: 'Параллельных сборок', type: 'number' },
        { path: ['limits', 'maxRunningBuilds'], label: 'Живых сборок (предупреждение)', type: 'number' },
        { path: ['limits', 'enforce'], label: 'Запрещать запуск сверх лимита', type: 'switch' },
        { path: ['limits', 'minFreeDiskGb'], label: 'Минимум свободного места, ГБ', type: 'number' },
        { path: ['dataDir'], label: 'Папка данных', type: 'text', description: 'после изменения перезапустите приложение' },
      ],
    },
    {
      title: 'Десктоп',
      fields: [
        { path: ['desktop', 'closeToTray'], label: 'Закрытие окна — в трей', type: 'switch' },
        { path: ['desktop', 'startMinimized'], label: 'Запускать свёрнутым (при автозапуске)', type: 'switch' },
        { path: ['desktop', 'autostart'], label: 'Автозапуск с Windows', type: 'switch', stage: 'этап 3' },
        { path: ['desktop', 'editor'], label: 'Редактор', type: 'text', description: 'code | cursor | путь к CLI' },
        { path: ['desktop', 'terminal'], label: 'Терминал', type: 'select', options: ['wt', 'git-bash', 'cmd'] },
        { path: ['desktop', 'dockerDesktopExe'], label: 'Docker Desktop.exe', type: 'text' },
        { path: ['desktop', 'gh'], label: 'gh CLI', type: 'text' },
      ],
    },
    {
      title: 'Обновления',
      fields: [
        { path: ['updates', 'checkOnStart'], label: 'Проверять обновления при запуске', type: 'switch' },
        { path: ['updates', 'includePrerelease'], label: 'Предлагать предварительные версии', type: 'switch' },
        { path: ['updates', 'repository'], label: 'GitHub-репозиторий релизов', type: 'text', description: 'owner/repo' },
      ],
    },
    {
      title: 'Уведомления Windows',
      fields: [
        { path: ['desktop', 'notifications', 'buildReady'], label: 'Сборка готова', type: 'switch' },
        { path: ['desktop', 'notifications', 'buildFailed'], label: 'Сборка упала', type: 'switch' },
        { path: ['desktop', 'notifications', 'testsFailed'], label: 'Тесты упали', type: 'switch' },
        { path: ['desktop', 'notifications', 'newBackup'], label: 'Найден новый бэкап прода', type: 'switch' },
        { path: ['desktop', 'notifications', 'lowDisk'], label: 'Мало места', type: 'switch' },
      ],
    },
  ];
  return (
    <Stack>
      <UpdatesCard />
      <Card withBorder>
        <YamlForm text={text} groups={groups} onSave={onSave} saving={saving} />
      </Card>
      <Card withBorder>
        <Stack>
          <Text fw={600}>app.yaml</Text>
          <YamlEditor path="app" schema="app" value={yaml} onChange={setYaml} height={320} />
          <Group justify="flex-end">
            <Button loading={saving} disabled={yaml === text} onClick={() => void onSave(yaml)}>
              Сохранить
            </Button>
          </Group>
        </Stack>
      </Card>
    </Stack>
  );
}
