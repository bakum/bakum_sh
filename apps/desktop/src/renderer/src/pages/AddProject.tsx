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
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconCheck, IconFolder, IconX } from '@tabler/icons-react';
import type { DetectResult, ProjectConfig } from '@bm/shared';
import { useBmMutation } from '../lib/query';
import { YamlEditor } from '../components/YamlEditor';

const ok = (v: unknown) => (v ? <IconCheck size={16} color="teal" /> : <IconX size={16} color="red" />);

/** Add-project wizard (spec 8.1): pick the repository folder → autodetect → choose preset → review YAML → create. */
export function AddProject() {
  const nav = useNavigate();
  const [path, setPath] = useState('');
  const [preset, setPreset] = useState<'demz' | 'generic'>('generic');
  const [edits, setEdits] = useState<{ id: string; name: string; production: string; worktreesDir: string }>({
    id: '',
    name: '',
    production: '',
    worktreesDir: '',
  });
  const [yaml, setYaml] = useState('');
  const [yamlDirty, setYamlDirty] = useState(false);
  const detect = useBmMutation('projects.detect');
  const create = useBmMutation('projects.create', { success: 'Проект добавлен' });
  const d: DetectResult | undefined = detect.data;

  useEffect(() => {
    if (!d) return;
    setPreset(d.suggestedPreset);
    const p = d.proposals[d.suggestedPreset];
    setEdits({ id: p.id, name: p.name, production: p.production.branch, worktreesDir: p.repo.worktreesDir });
    setYamlDirty(false);
  }, [d]);

  const generated = useMemo(() => {
    if (!d) return '';
    const base: ProjectConfig = structuredClone(d.proposals[preset]);
    base.id = edits.id || base.id;
    base.name = edits.name || base.name;
    base.production.branch = edits.production || base.production.branch;
    base.repo.worktreesDir = edits.worktreesDir || base.repo.worktreesDir;
    const doc = new YAML.Document(base);
    doc.commentBefore = ` Проект ${base.name}. Пресет: ${preset === 'demz' ? 'DEMZ' : 'Generic Odoo'}. Пароль Postgres будет подставлен из найденного контейнера.`;
    return doc.toString({ lineWidth: 120 });
  }, [d, preset, edits]);

  useEffect(() => {
    if (!yamlDirty) setYaml(generated);
  }, [generated, yamlDirty]);

  const pick = async () => {
    const p = await window.bm.desktop.selectDirectory('Папка git-репозитория с модулями Odoo');
    if (p) {
      setPath(p);
      detect.mutate({ path: p });
    }
  };

  return (
    <Container size="lg" py="lg">
      <Stack>
        <Title order={3}>Добавить проект</Title>
        <Card withBorder>
          <Stack gap="xs">
            <Text size="sm">Выберите папку локального клона репозитория с модулями Odoo.</Text>
            <Group align="flex-end">
              <TextInput
                style={{ flex: 1 }}
                label="Папка репозитория"
                placeholder="E:\demz-odoo-19\repositories\demz-odoo"
                value={path}
                onChange={(e) => setPath(e.currentTarget.value)}
              />
              <Button variant="default" leftSection={<IconFolder size={14} />} onClick={() => void pick()}>
                Выбрать папку…
              </Button>
              <Button disabled={!path} loading={detect.isPending} onClick={() => detect.mutate({ path })}>
                Определить
              </Button>
            </Group>
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
                      <Row k="Путь" v={<Code>{d.repoPath}</Code>} />
                      <Row k="Remote" v={<>{ok(d.remote)} {d.remote ?? 'нет'} {d.github && <Badge ml={4} variant="light">{d.github}</Badge>}</>} />
                      <Row k="Текущая ветка" v={d.currentBranch ?? '—'} />
                      <Row k="Кандидат в Production" v={<>{ok(d.productionCandidate)} {d.productionCandidate ?? 'не найден'}</>} />
                      <Row k="Ветки" v={`${d.branches.length}`} />
                      <Row k="Корни модулей" v={<>{ok(d.moduleRoots.length || d.moduleCount)} {d.moduleRoots.join(', ') || 'корень репозитория'} ({d.moduleCount} модулей)</>} />
                      <Row k="Список «моих» модулей" v={d.modulesToInstall ?? '—'} />
                    </Table.Tbody>
                  </Table>
                </Card>
              </Grid.Col>
              <Grid.Col span={6}>
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
              </Grid.Col>
            </Grid>

            <Card withBorder>
              <Stack>
                <Group justify="space-between">
                  <Text fw={600}>Пресет настроек</Text>
                  <SegmentedControl
                    value={preset}
                    onChange={(v) => {
                      setPreset(v as 'demz' | 'generic');
                      setYamlDirty(false);
                    }}
                    data={[
                      { value: 'demz', label: `DEMZ${d.suggestedPreset === 'demz' ? ' (рекомендуется)' : ''}` },
                      { value: 'generic', label: `Generic Odoo${d.suggestedPreset === 'generic' ? ' (рекомендуется)' : ''}` },
                    ]}
                  />
                </Group>
                <Text size="sm" c="dimmed">
                  {preset === 'demz'
                    ? 'Production = 19.0 (зеркало прода из бэкапа), Staging = 19.0-demz-crm и 19.0-demz-prerelease, Development — копия зеркала прода и обновление модулей на новый коммит.'
                    : 'Поведение odoo.sh по умолчанию: Development — чистая БД с «моими» модулями, новая сборка на каждый коммит.'}
                </Text>
                <Grid>
                  <Grid.Col span={3}>
                    <TextInput label="id проекта" description="a-z, 0-9, «-»; входит в имена ресурсов" value={edits.id} onChange={(e) => { setEdits({ ...edits, id: e.currentTarget.value }); setYamlDirty(false); }} />
                  </Grid.Col>
                  <Grid.Col span={3}>
                    <TextInput label="Название" value={edits.name} onChange={(e) => { setEdits({ ...edits, name: e.currentTarget.value }); setYamlDirty(false); }} />
                  </Grid.Col>
                  <Grid.Col span={2}>
                    <TextInput label="Ветка Production" value={edits.production} onChange={(e) => { setEdits({ ...edits, production: e.currentTarget.value }); setYamlDirty(false); }} />
                  </Grid.Col>
                  <Grid.Col span={4}>
                    <TextInput label="Папка worktree" value={edits.worktreesDir} onChange={(e) => { setEdits({ ...edits, worktreesDir: e.currentTarget.value }); setYamlDirty(false); }} />
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
                <Group justify="flex-end">
                  <Button
                    size="sm"
                    loading={create.isPending}
                    onClick={() => create.mutate({ yaml }, { onSuccess: (s) => nav(`/projects/${s.id}/branches`) })}
                  >
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
