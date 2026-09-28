import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import YAML from 'yaml';
import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Container,
  Grid,
  Group,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconFolder, IconX } from '@tabler/icons-react';
import { ODOO_VERSIONS, type DetectResult, type PresetId, type ProjectConfig } from '@bm/shared';
import { useBmMutation } from '../lib/query';
import { call, errorText } from '../lib/bm';
import { YamlEditor } from '../components/YamlEditor';
import { RepoClone } from '../components/RepoClone';

const ok = (v: unknown) => (v ? <IconCheck size={16} color="teal" /> : <IconX size={16} color="red" />);

const PRESET_LABEL: Record<PresetId, string> = { odoo: 'Odoo в Docker', generic: 'Generic Odoo', demz: 'DEMZ' };

const PRESET_TEXT: Record<PresetId, string> = {
  odoo:
    'Приложение само поднимает официальный образ Odoo и свой Postgres в Docker — ничего, кроме репозитория, не нужно. ' +
    'Production — чистая БД с вашими модулями (с папкой бэкапов — зеркало прода), Staging — копия Production, Development — чистая БД с демо-данными и новая сборка на каждый коммит.',
  generic: 'Уже настроенный Odoo в Docker: образ, сеть и Postgres берутся из найденного контейнера. Development — чистая БД с «моими» модулями, новая сборка на каждый коммит.',
  demz: 'Production = 19.0 (зеркало прода из бэкапа), Staging = 19.0-demz-crm и 19.0-demz-prerelease, Development — копия зеркала прода и обновление модулей на новый коммит.',
};

type Source = 'clone' | 'folder';
type EnterpriseSource = 'none' | 'folder' | 'clone';

/**
 * Add-project wizard (spec 8.1, D31–D33): repository URL (typed or taken from the user's folder) → the app's own copy →
 * autodetect → preset (Odoo version and Enterprise for «Odoo в Docker») → review YAML → create.
 */
export function AddProject() {
  const nav = useNavigate();
  const [source, setSource] = useState<Source>('clone');
  const [path, setPath] = useState('');
  /** The user's clone (folder source): its address and, for the Generic / DEMZ presets, its Odoo container. */
  const [folder, setFolder] = useState<{ top: string; url: string } | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [repo, setRepo] = useState<{ mirror: string; url: string } | null>(null);
  const [preset, setPreset] = useState<PresetId>('odoo');
  const [edits, setEdits] = useState<{ id: string; name: string; production: string; worktreesDir: string }>({
    id: '',
    name: '',
    production: '',
    worktreesDir: '',
  });
  const [odooVersion, setOdooVersion] = useState<string | null>(null);
  const [entSource, setEntSource] = useState<EnterpriseSource>('none');
  const [entPath, setEntPath] = useState('');
  const [yaml, setYaml] = useState('');
  const [yamlDirty, setYamlDirty] = useState(false);
  const [pgProblem, setPgProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const detect = useBmMutation('projects.detect');
  const create = useBmMutation('projects.create', { success: 'Проект добавлен' });
  const d: DetectResult | undefined = detect.data;

  const enterprisePath = entSource !== 'none' && entPath.trim() ? entPath.trim() : null;
  const runDetect = (opts?: { version?: string | null; enterprise?: string | null }) => {
    if (!repo) return;
    detect.mutate({
      ...repo,
      folder: source === 'folder' ? (folder?.top ?? null) : null,
      odoo: { version: (opts?.version ?? odooVersion) ?? undefined, enterprisePath: opts?.enterprise !== undefined ? opts.enterprise : enterprisePath },
    });
  };
  /** Another repository: the Odoo version comes from its manifests again, Enterprise is chosen anew. */
  const detectNew = (mirror: string, url: string) => {
    setRepo({ mirror, url });
    setOdooVersion(null);
    setEntSource('none');
    setEntPath('');
    detect.mutate({ mirror, url, folder: source === 'folder' ? (folder?.top ?? null) : null, odoo: { enterprisePath: null } });
  };

  // A new repository: preset, names and Odoo version start from the detection.
  useEffect(() => {
    if (!d) return;
    setPreset(d.suggestedPreset);
    const p = d.proposals[d.suggestedPreset];
    setEdits({ id: p.id, name: p.name, production: p.production.branch, worktreesDir: p.repo.worktreesDir });
    setOdooVersion(d.odooVersion);
    setYamlDirty(false);
    setPgProblem(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.mirrorDir]);

  // Enterprise folder typed by hand: re-detect after a pause (the detection validates it).
  useEffect(() => {
    if (!d || entSource !== 'folder') return;
    const t = setTimeout(() => runDetect(), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entPath]);

  const generated = useMemo(() => {
    if (!d) return '';
    const base: ProjectConfig = structuredClone(d.proposals[preset]);
    const origId = base.id;
    const origProd = base.production.branch;
    base.id = edits.id || base.id;
    base.name = edits.name || base.name;
    base.production.branch = edits.production || base.production.branch;
    base.repo.worktreesDir = edits.worktreesDir || base.repo.worktreesDir;
    if (base.production.branch !== origProd) {
      const swap = (list: string[]) => list.map((b) => (b === origProd ? base.production.branch : b));
      base.repo.protectedBranches = swap(base.repo.protectedBranches);
      base.naming.pr.targets = swap(base.naming.pr.targets);
      if (base.naming.branch.base === origProd) base.naming.branch.base = base.production.branch;
    }
    if (preset === 'odoo' && base.id !== origId) {
      // Resource names of «Odoo в Docker» are derived from the project id.
      base.runtime.network = `bm-${base.id}`;
      base.postgres.protectedContainers = [`bm-${base.id}-db`];
      base.naming.db = `bm_${base.id.replace(/-/g, '_')}_{slug_}_{build}`;
      base.naming.host = `{slug}.${base.id}.localhost`;
      base.runtime.filestore.hostDir = base.runtime.filestore.hostDir.replace(new RegExp(`/${origId}$`), `/${base.id}`);
    }
    const doc = new YAML.Document(base);
    doc.commentBefore =
      preset === 'odoo'
        ? ` Проект ${base.name}. Пресет: Odoo в Docker. Пароль своего Postgres приложение сгенерирует при создании.`
        : ` Проект ${base.name}. Пресет: ${PRESET_LABEL[preset]}. Пароль Postgres будет подставлен из найденного контейнера.`;
    return doc.toString({ lineWidth: 120 });
  }, [d, preset, edits]);

  useEffect(() => {
    if (!yamlDirty) setYaml(generated);
  }, [generated, yamlDirty]);

  /** The user's clone: only its address is read; the app still makes its own copy from that address. */
  const readFolder = async (p: string) => {
    setFolder(null);
    setFolderError(null);
    try {
      const r = await call('repo.folderRemote', { path: p });
      if (!r.url) setFolderError('У репозитория в этой папке нет remote (origin): приложению неоткуда брать код. Добавьте remote или укажите адрес.');
      else setFolder({ top: r.top, url: r.url });
    } catch (e) {
      setFolderError(errorText(e));
    }
  };
  const pick = async () => {
    const p = await window.bm.desktop.selectDirectory('Папка вашего клона репозитория с модулями Odoo');
    if (p) {
      setPath(p);
      void readFolder(p);
    }
  };

  const doCreate = () =>
    create.mutate(
      { yaml },
      {
        onSuccess: (s) => {
          if (preset === 'odoo') {
            notifications.show({
              color: 'blue',
              autoClose: 10000,
              message: 'Готовлю Postgres и образ Odoo (первая загрузка — несколько минут). Затем нажмите Rebuild на ветке Production.',
            });
          }
          nav(`/projects/${s.id}/branches`);
        },
      },
    );

  const onCreate = async () => {
    if (preset === 'odoo') return doCreate();
    setChecking(true);
    try {
      const r = await call('projects.checkPostgres', { yaml });
      if (r.ok) doCreate();
      else setPgProblem(r.text);
    } catch (e) {
      setPgProblem(errorText(e));
    } finally {
      setChecking(false);
    }
  };

  const proposal = d?.proposals.odoo;

  return (
    <Container size="lg" py="lg">
      <Stack>
        <Title order={3}>Добавить проект</Title>
        <Card withBorder>
          <Stack gap="xs">
            <Group justify="space-between">
              <Text fw={600}>Код проекта</Text>
              <SegmentedControl
                value={source}
                onChange={(v) => setSource(v as Source)}
                data={[
                  { value: 'clone', label: 'По адресу' },
                  { value: 'folder', label: 'Адрес из папки на диске' },
                ]}
              />
            </Group>
            {source === 'clone' ? (
              <>
                <Text size="sm" c="dimmed">
                  Git-репозиторий с вашими модулями Odoo (GitHub, GitLab…). Код сборок приложение берёт из своей копии этого репозитория, ваши клоны не
                  трогает. Для приватного репозитория приложение предложит войти или сохранить токен.
                </Text>
                <RepoClone mirror onCloned={(dir, url) => detectNew(dir, url)} />
              </>
            ) : (
              <>
                <Text size="sm">
                  Выберите папку своего клона. Приложение возьмёт из неё только адрес репозитория (и найдёт ваш контейнер Odoo, если он смонтирован), а код
                  сборок будет брать из своей копии. В папке ничего не меняется; её можно будет подключить как «свою папку» у веток Development.
                </Text>
                <Group align="flex-end">
                  <TextInput
                    style={{ flex: 1 }}
                    label="Папка вашего клона"
                    placeholder="E:\odoo\repositories\my-addons"
                    value={path}
                    onChange={(e) => setPath(e.currentTarget.value)}
                  />
                  <Button variant="default" leftSection={<IconFolder size={14} />} onClick={() => void pick()}>
                    Выбрать папку…
                  </Button>
                  <Button variant="default" disabled={!path} onClick={() => void readFolder(path)}>
                    Прочитать адрес
                  </Button>
                </Group>
                {folderError && (
                  <Alert color="red" variant="light">
                    {folderError}
                  </Alert>
                )}
                {folder && (
                  <>
                    <Text size="sm">
                      Адрес: <Code>{folder.url}</Code>
                    </Text>
                    <RepoClone key={folder.url} mirror initialUrl={folder.url} onCloned={(dir, url) => detectNew(dir, url)} />
                  </>
                )}
              </>
            )}
          </Stack>
        </Card>

        {d && (
          <>
            {d.warnings.map((w) => (
              <Alert key={w} color="orange" variant="light">
                {w}
              </Alert>
            ))}
            <Grid>
              <Grid.Col span={6}>
                <Card withBorder h="100%">
                  <Text fw={600} mb="xs">
                    Репозиторий
                  </Text>
                  <Table withRowBorders={false} verticalSpacing={3} fz="sm">
                    <Table.Tbody>
                      <Row k="Адрес" v={<>{d.url} {d.github && <Badge ml={4} variant="light">{d.github}</Badge>}</>} />
                      <Row k="Копия приложения" v={<Code>{d.mirrorDir}</Code>} />
                      {d.localFolder && <Row k="Ваша папка" v={<>{d.localFolder} (открыта ветка {d.currentBranch ?? '—'})</>} />}
                      <Row k="Кандидат в Production" v={<>{ok(d.productionCandidate)} {d.productionCandidate ?? 'не найден'}</>} />
                      <Row k="Ветки" v={`${d.branches.length}`} />
                      <Row k="Корни модулей" v={<>{ok(d.moduleRoots.length || d.moduleCount)} {d.moduleRoots.join(', ') || 'корень репозитория'} ({d.moduleCount} модулей)</>} />
                      <Row k="Список «моих» модулей" v={d.modulesToInstall ?? '— (ставятся все модули репозитория)'} />
                    </Table.Tbody>
                  </Table>
                </Card>
              </Grid.Col>
              <Grid.Col span={6}>
                {preset === 'odoo' && proposal ? (
                  <Card withBorder h="100%">
                    <Text fw={600} mb="xs">
                      Что поднимет приложение
                    </Text>
                    <Table withRowBorders={false} verticalSpacing={3} fz="sm">
                      <Table.Tbody>
                        <Row k="Образ Odoo" v={<Code>{proposal.runtime.image}</Code>} />
                        <Row k="Postgres" v={<>свой контейнер <Code>{proposal.postgres.image}</Code> на 127.0.0.1:{proposal.postgres.port}</>} />
                        <Row k="Docker-сеть" v={<Code>bm-{edits.id || proposal.id}</Code>} />
                        <Row k="Enterprise" v={proposal.runtime.enterprise ? <>{ok(true)} только чтение, {proposal.runtime.enterprise}</> : 'нет (Community)'} />
                        <Row k="filestore" v={<Code>{proposal.runtime.filestore.hostDir}</Code>} />
                        <Row k="Адреса сборок" v={<Code>http://&lt;ветка&gt;.{edits.id || proposal.id}.localhost</Code>} />
                      </Table.Tbody>
                    </Table>
                  </Card>
                ) : (
                  <Card withBorder h="100%">
                    <Text fw={600} mb="xs">
                      Рантайм Odoo
                    </Text>
                    <Table withRowBorders={false} verticalSpacing={3} fz="sm">
                      <Table.Tbody>
                        <Row k="Папка проекта" v={d.projectRoot ?? '—'} />
                        <Row k="compose / Dockerfile / odoo.conf" v={[d.composeFile, d.dockerfile, d.odooConf].filter(Boolean).length + ' из 3'} />
                        <Row k="Образ" v={<>{ok(d.image)} {d.image ?? 'не найден'}</>} />
                        <Row k="Сеть" v={<>{ok(d.network)} {d.network ?? 'не найдена'}</>} />
                        <Row k="Репозиторий в контейнере" v={d.repoMount ?? '—'} />
                        <Row k="Монтирования" v={`${d.mounts.length}`} />
                        <Row
                          k="Postgres"
                          v={
                            <>
                              {ok(d.postgres)}{' '}
                              {d.postgres
                                ? `${d.postgres.container} → ${d.postgres.host}:${d.postgres.port}, пользователь ${d.postgres.user}, пароль ${d.postgres.hasPassword ? 'найден' : 'не найден'}`
                                : 'не найден'}
                            </>
                          }
                        />
                      </Table.Tbody>
                    </Table>
                  </Card>
                )}
              </Grid.Col>
            </Grid>

            <Card withBorder>
              <Stack>
                <Group justify="space-between">
                  <Text fw={600}>Пресет настроек</Text>
                  <SegmentedControl
                    value={preset}
                    onChange={(v) => {
                      setPreset(v as PresetId);
                      setYamlDirty(false);
                      setPgProblem(null);
                    }}
                    data={(['odoo', 'generic', 'demz'] as PresetId[]).map((p) => ({
                      value: p,
                      label: `${PRESET_LABEL[p]}${d.suggestedPreset === p ? ' (рекомендуется)' : ''}`,
                    }))}
                  />
                </Group>
                <Text size="sm" c="dimmed">
                  {PRESET_TEXT[preset]}
                </Text>

                {preset === 'odoo' && (
                  <Card withBorder bg="var(--mantine-color-gray-light)">
                    <Stack gap="xs">
                      <Group align="flex-end">
                        <Select
                          w={160}
                          label="Версия Odoo"
                          data={[...ODOO_VERSIONS]}
                          value={odooVersion ?? d.odooVersion}
                          allowDeselect={false}
                          onChange={(v) => {
                            if (!v) return;
                            setOdooVersion(v);
                            setYamlDirty(false);
                            runDetect({ version: v });
                          }}
                        />
                        <Stack gap={2} style={{ flex: 1 }}>
                          <Text size="sm" fw={500}>
                            Odoo Enterprise
                          </Text>
                          <SegmentedControl
                            size="xs"
                            value={entSource}
                            onChange={(v) => {
                              const s = v as EnterpriseSource;
                              setEntSource(s);
                              setEntPath('');
                              setYamlDirty(false);
                              if (s === 'none') runDetect({ enterprise: null });
                            }}
                            data={[
                              { value: 'none', label: 'Нет (Community)' },
                              { value: 'folder', label: 'Папка на диске' },
                              { value: 'clone', label: 'Клонировать' },
                            ]}
                          />
                        </Stack>
                      </Group>
                      {entSource === 'folder' && (
                        <Group align="flex-end">
                          <TextInput
                            style={{ flex: 1 }}
                            label="Папка odoo/enterprise"
                            description={`Корень репозитория Enterprise ветки ${odooVersion ?? d.odooVersion} (в ней лежит web_enterprise). Монтируется только для чтения.`}
                            value={entPath}
                            onChange={(e) => setEntPath(e.currentTarget.value)}
                          />
                          <Button
                            variant="default"
                            leftSection={<IconFolder size={14} />}
                            onClick={async () => {
                              const p = await window.bm.desktop.selectDirectory('Папка репозитория odoo/enterprise');
                              if (p) setEntPath(p);
                            }}
                          >
                            Выбрать…
                          </Button>
                        </Group>
                      )}
                      {entSource === 'clone' && (
                        <>
                          <Text size="xs" c="dimmed">
                            Доступ к github.com/odoo/enterprise есть у партнёров Odoo и владельцев подписки. Клонируется только ветка{' '}
                            {odooVersion ?? d.odooVersion}, без истории.
                          </Text>
                          {entPath ? (
                            <Text size="sm" c="teal">
                              Enterprise: <Code>{entPath}</Code>
                            </Text>
                          ) : (
                            <RepoClone
                              key={odooVersion ?? d.odooVersion}
                              placeholder="https://github.com/odoo/enterprise.git"
                              branch={odooVersion ?? d.odooVersion}
                              shallow
                              suffix="-enterprise"
                              onCloned={(dir) => {
                                setEntPath(dir);
                                setYamlDirty(false);
                                runDetect({ enterprise: dir });
                              }}
                            />
                          )}
                        </>
                      )}
                    </Stack>
                  </Card>
                )}

                <Grid>
                  <Grid.Col span={3}>
                    <TextInput label="id проекта" description="a-z, 0-9, «-»; входит в имена ресурсов" value={edits.id} onChange={(e) => { setEdits({ ...edits, id: e.currentTarget.value }); setYamlDirty(false); }} />
                  </Grid.Col>
                  <Grid.Col span={3}>
                    <TextInput label="Название" value={edits.name} onChange={(e) => { setEdits({ ...edits, name: e.currentTarget.value }); setYamlDirty(false); }} />
                  </Grid.Col>
                  <Grid.Col span={2}>
                    {d.branches.length ? (
                      <Select
                        label="Ветка Production"
                        searchable
                        data={d.branches}
                        value={edits.production}
                        allowDeselect={false}
                        onChange={(v) => { if (v) { setEdits({ ...edits, production: v }); setYamlDirty(false); } }}
                      />
                    ) : (
                      <TextInput label="Ветка Production" value={edits.production} onChange={(e) => { setEdits({ ...edits, production: e.currentTarget.value }); setYamlDirty(false); }} />
                    )}
                  </Grid.Col>
                  <Grid.Col span={4}>
                    <TextInput label="Папка веток (worktree)" value={edits.worktreesDir} onChange={(e) => { setEdits({ ...edits, worktreesDir: e.currentTarget.value }); setYamlDirty(false); }} />
                  </Grid.Col>
                </Grid>
                <Tabs defaultValue="yaml">
                  <Tabs.List>
                    <Tabs.Tab value="yaml">YAML проекта</Tabs.Tab>
                  </Tabs.List>
                  <Tabs.Panel value="yaml" pt="xs">
                    <YamlEditor
                      path="new-project"
                      schema="project"
                      value={yaml}
                      height={420}
                      onChange={(v) => {
                        setYaml(v);
                        setYamlDirty(true);
                      }}
                    />
                  </Tabs.Panel>
                </Tabs>
                {pgProblem && (
                  <Alert color="orange" variant="light" title="Postgres недоступен">
                    <Stack gap="xs">
                      <Text size="sm">{pgProblem}</Text>
                      <Text size="sm">
                        Сборки не заработают, пока приложение не подключится к Postgres. Исправьте раздел postgres в YAML, выберите пресет «Odoo в Docker» (свой
                        Postgres) или создайте проект как есть и поправьте настройки позже.
                      </Text>
                      <Group>
                        <Button size="xs" variant="light" color="orange" loading={create.isPending} onClick={doCreate}>
                          Создать всё равно
                        </Button>
                      </Group>
                    </Stack>
                  </Alert>
                )}
                <Group justify="flex-end">
                  <Button size="sm" loading={create.isPending || checking} disabled={detect.isPending} onClick={() => void onCreate()}>
                    Создать проект
                  </Button>
                </Group>
              </Stack>
            </Card>
          </>
        )}
      </Stack>
    </Container>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <Table.Tr>
      <Table.Td c="dimmed" w={190}>
        {k}
      </Table.Td>
      <Table.Td>{v}</Table.Td>
    </Table.Tr>
  );
}
