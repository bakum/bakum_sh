import { useEffect, useMemo, useState } from 'react';
import YAML from 'yaml';
import {
  Badge,
  Button,
  Group,
  NumberInput,
  PasswordInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  TagsInput,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { t } from '../i18n';

export type FieldType = 'text' | 'number' | 'switch' | 'select' | 'tags' | 'textarea' | 'password' | 'keyvalue';

export interface FieldDef {
  path: (string | number)[];
  label: string;
  type: FieldType;
  options?: string[];
  /** Shown instead of the stored value in a select. */
  optionLabels?: Record<string, string>;
  description?: string;
  /** Not available yet: shown disabled with the stage badge. */
  /** Not acted upon yet: the field is shown disabled with this badge. */
  stage?: 'stage2' | 'stage3' | 'postponed';
  /** Optional field: an empty value removes the key (value comes from the upper level). */
  inherit?: string;
  nullable?: boolean;
}

export interface FieldGroup {
  title?: string;
  description?: string;
  fields: FieldDef[];
}

const key = (p: (string | number)[]) => p.join('.');

/** getIn returns collections as YAML nodes (YAMLSeq / YAMLMap), scalars as values. */
const valueAt = (doc: YAML.Document, p: (string | number)[]): unknown => {
  const v = doc.getIn(p);
  return YAML.isNode(v) ? v.toJS(doc) : v;
};

const pick = (obj: unknown, p: (string | number)[]): unknown =>
  p.reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string | number, unknown>)[k] : undefined), obj);

/**
 * Value shown for a field: the file's own, otherwise the effective one (schema defaults), so a key the file omits is
 * not shown empty or off. Fields that inherit from an upper level stay empty — empty means «take it from there».
 * A default is written to the file only when the user changes the field.
 */
const shownValue = (doc: YAML.Document, f: FieldDef, defaults: unknown): unknown => {
  const v = valueAt(doc, f.path);
  return v === undefined && f.inherit === undefined ? pick(defaults, f.path) : v;
};

function toInput(v: unknown, f: FieldDef): unknown {
  if (f.type === 'keyvalue') return v && typeof v === 'object' ? Object.entries(v as Record<string, string>).map(([k, x]) => `${k}=${x}`) : [];
  if (f.type === 'tags') return Array.isArray(v) ? v.map(String) : [];
  if (f.type === 'switch') return v === undefined ? null : !!v;
  if (v === null || v === undefined) return f.type === 'number' ? '' : '';
  return typeof v === 'object' ? JSON.stringify(v) : v;
}

/**
 * Form over a YAML document: edits are applied with setIn/deleteIn so comments and layout
 * of the file survive (spec 9.1 — the same file is edited by forms, Monaco and by hand).
 */
export function YamlForm(props: {
  text: string;
  groups: FieldGroup[];
  onSave: (text: string) => Promise<unknown>;
  saving?: boolean;
  /** Parsed configuration with defaults applied, for keys the file omits. */
  defaults?: unknown;
}) {
  const doc = useMemo(() => YAML.parseDocument(props.text), [props.text]);
  const fields = props.groups.flatMap((g) => g.fields);
  // Refetches bring a new defaults object with the same content: keyed by content, unsaved edits survive them.
  const defaultsKey = JSON.stringify(props.defaults ?? null);
  const initial = useMemo(() => Object.fromEntries(fields.map((f) => [key(f.path), toInput(shownValue(doc, f, props.defaults), f)])), [doc, defaultsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [values, setValues] = useState<Record<string, unknown>>(initial);
  useEffect(() => setValues(initial), [initial]);
  const dirty = fields.filter((f) => JSON.stringify(values[key(f.path)]) !== JSON.stringify(initial[key(f.path)]));

  const save = async () => {
    const next = YAML.parseDocument(props.text);
    for (const f of dirty) {
      const v = values[key(f.path)];
      const empty = v === '' || v === null || v === undefined || (Array.isArray(v) && v.length === 0 && f.inherit !== undefined);
      if (empty && (f.inherit !== undefined || f.nullable)) {
        if (f.nullable && f.inherit === undefined) next.setIn(f.path, null);
        else next.deleteIn(f.path);
        continue;
      }
      let out: unknown = v;
      if (f.type === 'number') out = Number(v);
      if (f.type === 'keyvalue') {
        out = Object.fromEntries((v as string[]).map((s) => [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)]).filter(([k]) => k));
      }
      if (f.type === 'text' && typeof initial[key(f.path)] === 'string' && String(initial[key(f.path)]).startsWith('{')) {
        try {
          out = JSON.parse(String(v));
        } catch {
          /* plain string */
        }
      }
      next.setIn(f.path, out);
    }
    await props.onSave(next.toString({ lineWidth: 120 }));
  };

  const set = (f: FieldDef, v: unknown) => setValues((s) => ({ ...s, [key(f.path)]: v }));

  return (
    <Stack>
      {props.groups.map((g, gi) => (
        <Stack key={gi} gap="xs">
          {g.title && <Title order={5}>{g.title}</Title>}
          {g.description && (
            <Text size="sm" c="dimmed">
              {g.description}
            </Text>
          )}
          <SimpleGrid cols={2} spacing="md" verticalSpacing="xs">
            {g.fields.map((f) => (
              <Field key={key(f.path)} f={f} value={values[key(f.path)]} onChange={(v) => set(f, v)} />
            ))}
          </SimpleGrid>
        </Stack>
      ))}
      <Group justify="flex-end">
        <Text size="sm" c="dimmed">
          {dirty.length ? t('form.changed', { n: dirty.length }) : t('form.noChanges')}
        </Text>
        <Button variant="default" disabled={!dirty.length} onClick={() => setValues(initial)}>
          {t('common.revert')}
        </Button>
        <Button disabled={!dirty.length} loading={props.saving} onClick={() => void save()}>
          {t('common.save')}
        </Button>
      </Group>
    </Stack>
  );
}

function Field({ f, value, onChange }: { f: FieldDef; value: unknown; onChange: (v: unknown) => void }) {
  const disabled = !!f.stage;
  const label = (
    <Group gap={6} wrap="nowrap">
      <span>{f.label}</span>
      {f.stage && (
        <Badge size="xs" variant="light" color="gray">
          {t(`form.${f.stage}`)}
        </Badge>
      )}
    </Group>
  );
  const desc = [f.description, f.inherit !== undefined ? t('form.empty', { inherit: f.inherit }) : null].filter(Boolean).join('; ');
  switch (f.type) {
    case 'number':
      return <NumberInput label={label} description={desc} disabled={disabled} value={value as number | string} onChange={onChange} />;
    case 'switch':
      return (
        <Stack gap={2} justify="flex-end">
          <Switch label={label} description={desc} disabled={disabled} checked={!!value} onChange={(e) => onChange(e.currentTarget.checked)} />
        </Stack>
      );
    case 'select':
      return (
        <Select
          label={label}
          description={desc}
          disabled={disabled}
          clearable={f.inherit !== undefined}
          data={f.options?.map((o) => ({ value: o, label: f.optionLabels?.[o] ?? o })) ?? []}
          value={(value as string) || null}
          onChange={(v) => onChange(v ?? '')}
        />
      );
    case 'tags':
    case 'keyvalue':
      return <TagsInput label={label} description={desc || (f.type === 'keyvalue' ? t('form.keyValue') : undefined)} disabled={disabled} value={value as string[]} onChange={onChange} />;
    case 'textarea':
      return <Textarea label={label} description={desc} disabled={disabled} autosize minRows={2} value={value as string} onChange={(e) => onChange(e.currentTarget.value)} />;
    case 'password':
      return <PasswordInput label={label} description={desc} disabled={disabled} value={value as string} onChange={(e) => onChange(e.currentTarget.value)} />;
    default:
      return <TextInput label={label} description={desc} disabled={disabled} value={value as string} onChange={(e) => onChange(e.currentTarget.value)} />;
  }
}
