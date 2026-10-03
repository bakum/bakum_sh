import { useEffect, useState } from 'react';
import { ActionIcon, Badge, Button, Card, Group, NumberInput, Select, Stack, Switch, Table, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { IconArrowBackUp, IconPencil } from '@tabler/icons-react';
import { LEVELS, levelLabel, type BranchScope, type BranchView, type EffectiveField, type Level, type Stage } from '@bm/shared';
import { useBm, useBmMutation } from '../../lib/query';
import { YamlEditor } from '../../components/YamlEditor';
import { t } from '../../i18n';

const LEVEL_COLOR: Record<Level, string> = { app: 'gray', project: 'blue', stage: 'violet', rule: 'cyan', branch: 'orange' };

interface Editable {
  path: string;
  label: string;
  kind: 'select' | 'text' | 'number' | 'switch' | 'env';
  options?: string[];
  /** Not acted upon yet: shown read-only with this badge (stage 2, postponed). */
  stage?: string;
  /** Shown under the label when the name alone is ambiguous. */
  hint?: string;
}

const fieldDefs = (): Editable[] => [
  { path: 'onNewCommit', label: t('field.onNewCommit'), kind: 'select', options: ['none', 'update', 'new'] },
  { path: 'database', label: t('field.database'), kind: 'text' },
  { path: 'install', label: t('field.install'), kind: 'select', options: ['my', 'roots', 'full'] },
  { path: 'withDemo', label: t('field.withDemo'), kind: 'switch' },
  { path: 'updateModules', label: t('field.updateModules'), kind: 'select', options: ['changed', 'version-bumped', 'all'] },
  { path: 'onForcePush', label: t('field.onForcePush'), kind: 'select', options: ['pause', 'new'] },
  { path: 'cloneMethod', label: t('field.cloneMethod'), kind: 'select', options: ['template', 'dump'] },
  { path: 'filestoreCopy', label: t('field.filestoreCopy'), kind: 'select', options: ['hardlink', 'copy'] },
  { path: 'image', label: t('field.image'), kind: 'text' },
  { path: 'env', label: t('field.env'), kind: 'env' },
  { path: 'protected', label: t('field.protected'), kind: 'switch' },
  { path: 'buildOnAdd', label: t('field.buildOnAdd'), kind: 'switch' },
  { path: 'deleteWithRemote', label: t('field.deleteWithRemote'), kind: 'switch', hint: t('field.deleteWithRemoteHint') },
  { path: 'idleStopHours', label: t('field.idleStopHours'), kind: 'number' },
  { path: 'dropAfterDays', label: t('field.dropAfterDays'), kind: 'number' },
  { path: 'tests.mode', label: t('field.tests'), kind: 'select', options: ['none', 'changed', 'my'] },
  { path: 'tests.failBuild', label: t('field.failBuild'), kind: 'switch' },
  { path: 'mails.enabled', label: t('field.mailpit'), kind: 'switch', stage: t('form.postponed') },
];

function show(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const out = structuredClone(obj);
  const parts = path.split('.');
  let cur = out;
  for (const p of parts.slice(0, -1)) {
    cur[p] = typeof cur[p] === 'object' && cur[p] !== null ? cur[p] : {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
  return out;
}

function unsetPath(obj: Record<string, unknown>, path: string): Record<string, unknown> {
  const out = structuredClone(obj);
  const parts = path.split('.');
  let cur: Record<string, unknown> | undefined = out;
  for (const p of parts.slice(0, -1)) cur = cur?.[p] as Record<string, unknown> | undefined;
  if (cur) delete cur[parts[parts.length - 1]!];
  if (parts.length > 1) {
    const parent = out[parts[0]!] as Record<string, unknown> | undefined;
    if (parent && !Object.keys(parent).length) delete out[parts[0]!];
  }
  return out;
}

/** Branch Settings (spec 8.9 / 9.1): effective value + source level for each field, overrides, «Сбросить». */
export function SettingsTab({ branch }: { branch: BranchView }) {
  const eff = useBm('config.effective', { branchId: branch.id });
  const ov = useBm('config.get', { level: 'branch', branchId: branch.id });
  const save = useBmMutation('branches.setOverrides', { success: t('bs.saved') });
  const setStage = useBmMutation('branches.setStage', { success: t('bs.stageChanged') });
  const reset = useBmMutation('branches.resetToRule', { success: t('bs.stageReset') });
  const putYaml = useBmMutation('config.put', { success: t('bs.overridesSaved') });
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<unknown>(null);
  const [yaml, setYaml] = useState('');
  useEffect(() => {
    if (ov.data) setYaml(ov.data.yaml);
  }, [ov.data]);
  if (!eff.data) return null;
  const fields = new Map<string, EffectiveField>(eff.data.fields.map((f) => [f.path, f]));
  const overrides = eff.data.branchOverrides as Record<string, unknown>;
  const envField = eff.data.fields.find((f) => f.path === 'env');

  const commit = (path: string, value: unknown) => {
    save.mutate({ branchId: branch.id, overrides: setPath(overrides, path, value) as BranchScope });
    setEditing(null);
  };

  return (
    <Stack>
      <Card withBorder>
        <Group justify="space-between">
          <Group>
            <Text fw={600}>{t('bs.stage')}</Text>
            <Select
              w={180}
              data={[
                { value: 'production', label: 'Production' },
                { value: 'development', label: 'Development' },
              ]}
              value={branch.stage}
              disabled={branch.stage === 'production'}
              onChange={(v) => v && v !== branch.stage && setStage.mutate({ branchId: branch.id, stage: v as Stage })}
            />
            <Badge color={branch.assignedBy === 'user' ? 'orange' : 'cyan'} variant="light">
              {branch.assignedBy === 'user' ? t('bs.pinned') : `${t('bs.byRule')}${eff.data.ruleIndex !== null ? ` #${eff.data.ruleIndex + 1}` : ''}`}
            </Badge>
          </Group>
          <Button variant="default" disabled={branch.assignedBy !== 'user' || branch.stage === 'production'} onClick={() => reset.mutate({ branchId: branch.id })}>
            {t('bs.resetToRule')}
          </Button>
        </Group>
      </Card>

      <Card withBorder padding={0}>
        <Table verticalSpacing={6} highlightOnHover data-testid="branch-settings">
          <Table.Thead>
            <Table.Tr>
              <Table.Th pl="md">{t('bs.param')}</Table.Th>
              <Table.Th>{t('bs.effective')}</Table.Th>
              <Table.Th>{t('bs.from')}</Table.Th>
              <Table.Th w={90} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {fieldDefs().map((def) => {
              const f = def.kind === 'env' ? envField : fields.get(def.path);
              const isOverridden = def.path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], overrides) !== undefined;
              return (
                <Table.Tr key={def.path} data-field={def.path}>
                  <Table.Td pl="md">
                    <Group gap={6}>
                      <Text size="sm">{def.label}</Text>
                      {def.stage && (
                        <Badge size="xs" color="gray" variant="light">
                          {def.stage}
                        </Badge>
                      )}
                    </Group>
                    <Text size="xs" c="dimmed">
                      {def.path}
                    </Text>
                    {def.hint && (
                      <Text size="xs" c="dimmed" maw={360}>
                        {def.hint}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    {editing === def.path ? (
                      <Editor def={def} value={draft} onChange={setDraft} onDone={() => commit(def.path, def.kind === 'env' ? parseEnv(draft as string) : draft)} onCancel={() => setEditing(null)} />
                    ) : (
                      <Text size="sm" ff="monospace">
                        {show(f?.value)}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    {f && (
                      <Badge color={LEVEL_COLOR[f.level]} variant="light" data-level={f.level}>
                        {levelLabel(f.level)}
                      </Badge>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Group gap={2} wrap="nowrap">
                      {!def.stage && (
                        <Tooltip label={t('bs.override')}>
                          <ActionIcon
                            onClick={() => {
                              setEditing(def.path);
                              setDraft(def.kind === 'env' ? Object.entries((f?.value as Record<string, string>) ?? {}).map(([k, v]) => `${k}=${v}`).join('\n') : f?.value);
                            }}
                            aria-label={t('bs.edit', { path: def.path })}
                          >
                            <IconPencil size={14} />
                          </ActionIcon>
                        </Tooltip>
                      )}
                      {isOverridden && (
                        <Tooltip label={t('bs.unset')}>
                          <ActionIcon color="orange" onClick={() => save.mutate({ branchId: branch.id, overrides: unsetPath(overrides, def.path) as BranchScope })} aria-label={t('bs.unsetPath', { path: def.path })}>
                            <IconArrowBackUp size={14} />
                          </ActionIcon>
                        </Tooltip>
                      )}
                    </Group>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Card>

      <Card withBorder>
        <Stack>
          <Title order={6}>{t('bs.yamlTitle')}</Title>
          <YamlEditor path={`branch-${branch.id}`} schema="branch" value={yaml} onChange={setYaml} height={200} />
          <Group justify="flex-end">
            <Button disabled={yaml === ov.data?.yaml} loading={putYaml.isPending} onClick={() => putYaml.mutate({ level: 'branch', branchId: branch.id, yaml })}>
              {t('bs.saveYaml')}
            </Button>
          </Group>
          <Text size="xs" c="dimmed">
            {t('bs.levels', { levels: LEVELS.map((k) => `${k} — ${levelLabel(k)}`).join(' → ') })}
          </Text>
        </Stack>
      </Card>
    </Stack>
  );
}

function parseEnv(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1)]),
  );
}

function Editor({ def, value, onChange, onDone, onCancel }: { def: Editable; value: unknown; onChange: (v: unknown) => void; onDone: () => void; onCancel: () => void }) {
  const control =
    def.kind === 'select' ? (
      <Select size="xs" data={def.options ?? []} value={typeof value === 'string' ? value : null} onChange={(v) => onChange(v)} w={160} />
    ) : def.kind === 'switch' ? (
      <Switch checked={!!value} onChange={(e) => onChange(e.currentTarget.checked)} />
    ) : def.kind === 'number' ? (
      <NumberInput size="xs" value={value as number} onChange={(v) => onChange(Number(v))} w={120} />
    ) : def.kind === 'env' ? (
      <TextInput size="xs" value={String(value ?? '').replace(/\n/g, '; ')} onChange={(e) => onChange(e.currentTarget.value.replace(/;\s*/g, '\n'))} w={320} placeholder="KEY=value; KEY2=value" />
    ) : (
      <TextInput size="xs" value={String(value ?? '')} onChange={(e) => onChange(e.currentTarget.value)} w={220} />
    );
  return (
    <Group gap={6} wrap="nowrap">
      {control}
      <Button size="compact-xs" onClick={onDone}>
        OK
      </Button>
      <Button size="compact-xs" variant="default" onClick={onCancel}>
        ×
      </Button>
    </Group>
  );
}
