import { useEffect, useMemo, useState, type ReactNode } from 'react';
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
import { t, tx } from '../i18n';

const ok = (v: unknown) => (v ? <IconCheck size={16} color="teal" /> : <IconX size={16} color="red" />);

const presetLabel = (p: PresetId): string => t(`preset.${p}`);
const presetText = (p: PresetId): string => t(`presetText.${p}`);
const code = { code: (x: ReactNode) => <Code>{x}</Code> };

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
  const create = useBmMutation('projects.create', { success: t('ap.added') });
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
    if (base.postgres.mode === 'managed' && base.id !== origId) {
      // The app's own Postgres and its network are named after the project id.
      base.runtime.network = `bm-${base.id}`;
      base.postgres.protectedContainers = base.postgres.protectedContainers.map((c) => (c === `bm-${origId}-db` ? `bm-${base.id}-db` : c));
    }
    if (preset === 'odoo' && base.id !== origId) {
      // Resource names of «Odoo в Docker» are derived from the project id.
      base.naming.db = `bm_${base.id.replace(/-/g, '_')}_{slug_}_{build}`;
      base.naming.host = `{slug}.${base.id}.localhost`;
      base.runtime.filestore.hostDir = base.runtime.filestore.hostDir.replace(new RegExp(`/${origId}$`), `/${base.id}`);
    }
    const doc = new YAML.Document(base);
    doc.commentBefore =
      preset === 'odoo'
        ? t('ap.yamlOdoo', { name: base.name })
        : t(base.postgres.mode === 'managed' ? 'ap.yamlManaged' : 'ap.yamlExternal', { name: base.name, preset: presetLabel(preset) });
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
      if (!r.url) setFolderError(t('ap.noRemote'));
      else setFolder({ top: r.top, url: r.url });
    } catch (e) {
      setFolderError(errorText(e));
    }
  };
  const pick = async () => {
    const p = await window.bm.desktop.selectDirectory(t('ap.pickFolder'));
    if (p) {
      setPath(p);
      void readFolder(p);
    }
  };

  /** The app's own Postgres needs no connection check: it is started after the project is created. */
  const managed = () => {
    try {
      return YAML.parse(yaml)?.postgres?.mode === 'managed';
    } catch {
      return false;
    }
  };

  const doCreate = () =>
    create.mutate(
      { yaml },
      {
        onSuccess: (s) => {
          if (managed()) {
            notifications.show({
              color: 'blue',
              autoClose: 10000,
              message:
                preset === 'odoo'
                  ? t('ap.preparingOdoo')
                  : t('ap.preparingPg'),
            });
          }
          nav(`/projects/${s.id}/branches`);
        },
      },
    );

  const onCreate = async () => {
    if (managed()) return doCreate();
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
        <Title order={3}>{t('ap.title')}</Title>
        <Card withBorder>
          <Stack gap="xs">
            <Group justify="space-between">
              <Text fw={600}>{t('ap.code')}</Text>
              <SegmentedControl
                value={source}
                onChange={(v) => setSource(v as Source)}
                data={[
                  { value: 'clone', label: t('ap.byUrl') },
                  { value: 'folder', label: t('ap.fromFolder') },
                ]}
              />
            </Group>
            {source === 'clone' ? (
              <>
                <Text size="sm" c="dimmed">
                  {t('ap.urlHint')}
                </Text>
                <RepoClone mirror onCloned={(dir, url) => detectNew(dir, url)} />
              </>
            ) : (
              <>
                <Text size="sm">
                  {t('ap.folderHint')}
                </Text>
                <Group align="flex-end">
                  <TextInput
                    style={{ flex: 1 }}
                    label={t('ap.cloneFolder')}
                    placeholder="E:\odoo\repositories\my-addons"
                    value={path}
                    onChange={(e) => setPath(e.currentTarget.value)}
                  />
                  <Button variant="default" leftSection={<IconFolder size={14} />} onClick={() => void pick()}>
                    {t('ap.pick')}
                  </Button>
                  <Button variant="default" disabled={!path} onClick={() => void readFolder(path)}>
                    {t('ap.readUrl')}
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
                      {t('ap.address')} <Code>{folder.url}</Code>
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
                    {t('ap.repo')}
                  </Text>
                  <Table withRowBorders={false} verticalSpacing={3} fz="sm">
                    <Table.Tbody>
                      <Row k={t('ap.rowAddress')} v={<>{d.url} {d.github && <Badge ml={4} variant="light">{d.github}</Badge>}</>} />
                      <Row k={t('ap.rowMirror')} v={<Code>{d.mirrorDir}</Code>} />
                      {d.localFolder && <Row k={t('ap.rowFolder')} v={<>{d.localFolder} {t('ap.openBranch', { branch: d.currentBranch ?? '—' })}</>} />}
                      <Row k={t('ap.rowProd')} v={<>{ok(d.productionCandidate)} {d.productionCandidate ?? t('ap.notFound')}</>} />
                      <Row k={t('ap.rowBranches')} v={`${d.branches.length}`} />
                      <Row
                        k={t('ap.rowRoots')}
                        v={<>{ok(d.moduleRoots.length || d.moduleCount)} {d.moduleRoots.join(', ') || t('ap.repoRoot')} {t('ap.modules', { n: d.moduleCount })}</>}
                      />
                      <Row k={t('ap.rowMine')} v={d.modulesToInstall ?? t('ap.allModules')} />
                    </Table.Tbody>
                  </Table>
                </Card>
              </Grid.Col>
              <Grid.Col span={6}>
                {preset === 'odoo' && proposal ? (
                  <Card withBorder h="100%">
                    <Text fw={600} mb="xs">
                      {t('ap.willStart')}
                    </Text>
                    <Table withRowBorders={false} verticalSpacing={3} fz="sm">
                      <Table.Tbody>
                        <Row k={t('ap.rowImage')} v={<Code>{proposal.runtime.image}</Code>} />
                        <Row k="Postgres" v={tx('ap.ownContainer', { image: proposal.postgres.image, port: proposal.postgres.port }, code)} />
                        <Row k={t('ap.rowNetwork')} v={<Code>bm-{edits.id || proposal.id}</Code>} />
                        <Row
                          k="Enterprise"
                          v={proposal.runtime.enterprise ? <>{ok(true)} {t('ap.readOnly', { dir: proposal.runtime.enterprise })}</> : t('ap.noEnterprise')}
                        />
                        <Row k="filestore" v={<Code>{proposal.runtime.filestore.hostDir}</Code>} />
                        <Row k={t('ap.rowUrls')} v={<Code>{t('ap.urlSample', { id: edits.id || proposal.id })}</Code>} />
                      </Table.Tbody>
                    </Table>
                  </Card>
                ) : (
                  <Card withBorder h="100%">
                    <Text fw={600} mb="xs">
                      {t('ap.runtime')}
                    </Text>
                    <Table withRowBorders={false} verticalSpacing={3} fz="sm">
                      <Table.Tbody>
                        <Row k={t('ap.rowProjectDir')} v={d.projectRoot ?? '—'} />
                        <Row k="compose / Dockerfile / odoo.conf" v={t('ap.ofThree', { n: [d.composeFile, d.dockerfile, d.odooConf].filter(Boolean).length })} />
                        <Row k={t('ap.rowImageShort')} v={<>{ok(d.image)} {d.image ?? t('ap.notFound')}</>} />
                        {d.proposals[preset].postgres.mode === 'managed' ? (
                          <Row k={t('ap.rowNetwork')} v={<Code>bm-{edits.id || d.proposals[preset].id}</Code>} />
                        ) : (
                          <Row k={t('ap.rowNet')} v={<>{ok(d.network)} {d.network ?? t('ap.notFoundF')}</>} />
                        )}
                        <Row k={t('ap.rowRepoMount')} v={d.repoMount ?? '—'} />
                        <Row k={t('ap.rowMounts')} v={`${d.mounts.length}`} />
                        {d.proposals[preset].postgres.mode === 'managed' && (
                          <Row
                            k="Postgres"
                            v={tx('ap.ownContainer', { image: d.proposals[preset].postgres.image, port: d.proposals[preset].postgres.port }, code)}
                          />
                        )}
                        <Row
                          k={d.proposals[preset].postgres.mode === 'managed' ? t('ap.foundPg') : 'Postgres'}
                          v={
                            <>
                              {ok(d.postgres)}{' '}
                              {d.postgres
                                ? t('ap.pgFound', {
                                    container: d.postgres.container,
                                    host: d.postgres.host,
                                    port: d.postgres.port,
                                    user: d.postgres.user,
                                    pw: t(d.postgres.hasPassword ? 'ap.pwFound' : 'ap.notFound'),
                                  })
                                : t('ap.notFound')}
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
                  <Text fw={600}>{t('ap.presetTitle')}</Text>
                  <SegmentedControl
                    value={preset}
                    onChange={(v) => {
                      setPreset(v as PresetId);
                      setYamlDirty(false);
                      setPgProblem(null);
                    }}
                    data={(['odoo', 'generic', 'demz'] as PresetId[]).map((p) => ({
                      value: p,
                      label: `${presetLabel(p)}${d.suggestedPreset === p ? t('ap.recommended') : ''}`,
                    }))}
                  />
                </Group>
                <Text size="sm" c="dimmed">
                  {presetText(preset)}
                </Text>

                {preset === 'odoo' && (
                  <Card withBorder bg="var(--mantine-color-gray-light)">
                    <Stack gap="xs">
                      <Group align="flex-end">
                        <Select
                          w={160}
                          label={t('ap.odooVersion')}
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
                              { value: 'none', label: t('ap.entNone') },
                              { value: 'folder', label: t('ap.entFolder') },
                              { value: 'clone', label: t('ap.entClone') },
                            ]}
                          />
                        </Stack>
                      </Group>
                      {entSource === 'folder' && (
                        <Group align="flex-end">
                          <TextInput
                            style={{ flex: 1 }}
                            label={t('ap.entDir')}
                            description={t('ap.entDirHint', { version: odooVersion ?? d.odooVersion })}
                            value={entPath}
                            onChange={(e) => setEntPath(e.currentTarget.value)}
                          />
                          <Button
                            variant="default"
                            leftSection={<IconFolder size={14} />}
                            onClick={async () => {
                              const p = await window.bm.desktop.selectDirectory(t('ap.entPick'));
                              if (p) setEntPath(p);
                            }}
                          >
                            {t('repo.choose')}
                          </Button>
                        </Group>
                      )}
                      {entSource === 'clone' && (
                        <>
                          <Text size="xs" c="dimmed">
                            {t('ap.entAccess', { version: odooVersion ?? d.odooVersion })}
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
                    <TextInput label={t('ap.projectId')} description={t('ap.projectIdHint')} value={edits.id} onChange={(e) => { setEdits({ ...edits, id: e.currentTarget.value }); setYamlDirty(false); }} />
                  </Grid.Col>
                  <Grid.Col span={3}>
                    <TextInput label={t('ap.name')} value={edits.name} onChange={(e) => { setEdits({ ...edits, name: e.currentTarget.value }); setYamlDirty(false); }} />
                  </Grid.Col>
                  <Grid.Col span={2}>
                    {d.branches.length ? (
                      <Select
                        label={t('ap.prodBranch')}
                        searchable
                        data={d.branches}
                        value={edits.production}
                        allowDeselect={false}
                        onChange={(v) => { if (v) { setEdits({ ...edits, production: v }); setYamlDirty(false); } }}
                      />
                    ) : (
                      <TextInput label={t('ap.prodBranch')} value={edits.production} onChange={(e) => { setEdits({ ...edits, production: e.currentTarget.value }); setYamlDirty(false); }} />
                    )}
                  </Grid.Col>
                  <Grid.Col span={4}>
                    <TextInput label={t('ap.worktrees')} value={edits.worktreesDir} onChange={(e) => { setEdits({ ...edits, worktreesDir: e.currentTarget.value }); setYamlDirty(false); }} />
                  </Grid.Col>
                </Grid>
                <Tabs defaultValue="yaml">
                  <Tabs.List>
                    <Tabs.Tab value="yaml">{t('ap.yaml')}</Tabs.Tab>
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
                  <Alert color="orange" variant="light" title={t('ap.pgDown')}>
                    <Stack gap="xs">
                      <Text size="sm">{pgProblem}</Text>
                      <Text size="sm">
                        {t('ap.pgDownHint')}
                      </Text>
                      <Group>
                        <Button size="xs" variant="light" color="orange" loading={create.isPending} onClick={doCreate}>
                          {t('ap.createAnyway')}
                        </Button>
                      </Group>
                    </Stack>
                  </Alert>
                )}
                <Group justify="flex-end">
                  <Button size="sm" loading={create.isPending || checking} disabled={detect.isPending} onClick={() => void onCreate()}>
                    {t('ap.create')}
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

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <Table.Tr>
      <Table.Td c="dimmed" w={190}>
        {k}
      </Table.Td>
      <Table.Td>{v}</Table.Td>
    </Table.Tr>
  );
}
