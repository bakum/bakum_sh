import { useEffect, useState } from 'react';
import { ActionIcon, Badge, Button, Card, Group, NumberInput, Select, Stack, Switch, Table, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { IconArrowBackUp, IconPencil } from '@tabler/icons-react';
import { LEVEL_LABELS, type BranchScope, type BranchView, type EffectiveField, type Level, type Stage } from '@bm/shared';
import { useBm, useBmMutation } from '../../lib/query';
import { YamlEditor } from '../../components/YamlEditor';

const LEVEL_COLOR: Record<Level, string> = { app: 'gray', project: 'blue', stage: 'violet', rule: 'cyan', branch: 'orange' };

interface Editable {
  path: string;
  label: string;
  kind: 'select' | 'text' | 'number' | 'switch' | 'env';
  options?: string[];
  stage2?: boolean;
}

const FIELDS: Editable[] = [
  { path: 'onNewCommit', label: 'Новый коммит', kind: 'select', options: ['none', 'update', 'new'] },
  { path: 'database', label: 'База данных', kind: 'text' },
  { path: 'install', label: 'Установка (fresh)', kind: 'select', options: ['my', 'roots', 'full'] },
  { path: 'withDemo', label: 'Демо-данные (fresh)', kind: 'switch' },
  { path: 'updateModules', label: 'Обновлять модули', kind: 'select', options: ['changed', 'all'] },
  { path: 'tracking', label: 'Код ветки (tracking)', kind: 'select', options: ['local', 'remote'] },
  { path: 'onForcePush', label: 'Force-push', kind: 'select', options: ['pause', 'new'] },
  { path: 'cloneMethod', label: 'Копирование БД', kind: 'select', options: ['template'] },
  { path: 'filestoreCopy', label: 'Копирование filestore', kind: 'select', options: ['hardlink', 'copy'] },
  { path: 'image', label: 'Образ Odoo', kind: 'text' },
  { path: 'env', label: 'Переменные окружения', kind: 'env' },
  { path: 'protected', label: 'Защита от удаления', kind: 'switch' },
  { path: 'buildOnAdd', label: 'Собирать при добавлении', kind: 'switch' },
  { path: 'idleStopHours', label: 'Остановка без активности, ч', kind: 'number', stage2: true },
  { path: 'dropAfterDays', label: 'Отбросить через, дней', kind: 'number', stage2: true },
  { path: 'tests.mode', label: 'Тесты', kind: 'select', options: ['none', 'changed', 'my'], stage2: true },
  { path: 'mails.enabled', label: 'Mailpit', kind: 'switch', stage2: true },
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
  const save = useBmMutation('branches.setOverrides', { success: 'Настройки ветки сохранены' });
  const setStage = useBmMutation('branches.setStage', { success: 'Стадия изменена' });
  const reset = useBmMutation('branches.resetToRule', { success: 'Стадия сброшена к правилу' });
  const putYaml = useBmMutation('config.put', { success: 'Переопределения сохранены' });
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
            <Text fw={600}>Стадия</Text>
            <Select
              w={180}
              data={[
                { value: 'production', label: 'Production' },
                { value: 'staging', label: 'Staging' },
                { value: 'development', label: 'Development' },
              ]}
              value={branch.stage}
              disabled={branch.stage === 'production'}
              onChange={(v) => v && v !== branch.stage && setStage.mutate({ branchId: branch.id, stage: v as Stage })}
            />
            <Badge color={branch.assignedBy === 'user' ? 'orange' : 'cyan'} variant="light">
              {branch.assignedBy === 'user' ? 'зафиксирована вручную' : `по правилу${eff.data.ruleIndex !== null ? ` #${eff.data.ruleIndex + 1}` : ''}`}
            </Badge>
          </Group>
          <Button variant="default" disabled={branch.assignedBy !== 'user' || branch.stage === 'production'} onClick={() => reset.mutate({ branchId: branch.id })}>
            Сбросить к правилу
          </Button>
        </Group>
      </Card>

      <Card withBorder padding={0}>
        <Table verticalSpacing={6} highlightOnHover data-testid="branch-settings">
          <Table.Thead>
            <Table.Tr>
              <Table.Th pl="md">Параметр</Table.Th>
              <Table.Th>Действующее значение</Table.Th>
              <Table.Th>Откуда</Table.Th>
              <Table.Th w={90} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {FIELDS.map((def) => {
              const f = def.kind === 'env' ? envField : fields.get(def.path);
              const isOverridden = def.path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], overrides) !== undefined;
              return (
                <Table.Tr key={def.path} data-field={def.path}>
                  <Table.Td pl="md">
                    <Group gap={6}>
                      <Text size="sm">{def.label}</Text>
                      {def.stage2 && (
                        <Badge size="xs" color="gray" variant="light">
                          этап 2
                        </Badge>
                      )}
                    </Group>
                    <Text size="xs" c="dimmed">
                      {def.path}
                    </Text>
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
                        {LEVEL_LABELS[f.level]}
                      </Badge>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Group gap={2} wrap="nowrap">
                      {!def.stage2 && (
                        <Tooltip label="Переопределить в ветке">
                          <ActionIcon
                            onClick={() => {
                              setEditing(def.path);
                              setDraft(def.kind === 'env' ? Object.entries((f?.value as Record<string, string>) ?? {}).map(([k, v]) => `${k}=${v}`).join('\n') : f?.value);
                            }}
                            aria-label={`Изменить ${def.path}`}
                          >
                            <IconPencil size={14} />
                          </ActionIcon>
                        </Tooltip>
                      )}
                      {isOverridden && (
                        <Tooltip label="Сбросить (взять с верхнего уровня)">
                          <ActionIcon color="orange" onClick={() => save.mutate({ branchId: branch.id, overrides: unsetPath(overrides, def.path) as BranchScope })} aria-label={`Сбросить ${def.path}`}>
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
          <Title order={6}>Переопределения ветки (YAML)</Title>
          <YamlEditor path={`branch-${branch.id}`} schema="branch" value={yaml} onChange={setYaml} height={200} />
          <Group justify="flex-end">
            <Button disabled={yaml === ov.data?.yaml} loading={putYaml.isPending} onClick={() => putYaml.mutate({ level: 'branch', branchId: branch.id, yaml })}>
              Сохранить YAML
            </Button>
          </Group>
          <Text size="xs" c="dimmed">
            Уровни: {Object.entries(LEVEL_LABELS).map(([k, v]) => `${k} — ${v}`).join(' → ')}. Нижний уровень переопределяет верхний.
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
