import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  BmError,
  IDENTITY_PATHS,
  MACHINE_PATHS,
  SECRET_PATHS,
  type PresetId,
  type PresetInfo,
  type PresetOverlay,
} from '@bm/shared';
import type { Ctx } from '../context';
import { nowIso } from '../util/time';
import { audit } from './audit';
import { coreMessages, t } from '../i18n';

/**
 * Saved presets and project export / import (spec 8.1, 9.4; D73). Export writes the project YAML (comments kept)
 * without secrets and, by choice, without the paths of this machine. A preset is the same without the project's
 * identity, wrapped as `preset:` + `config:` in `<settings>/presets/<name>.yaml`; the wizard lays it over the detection.
 */

const PRESET_IDS: PresetId[] = ['odoo', 'generic', 'demz'];
const FILE_RE = /^[a-z0-9][a-z0-9-]*\.yaml$/;
const MAX_BYTES = 1024 * 1024;

export const presetsDir = (ctx: Ctx): string => path.join(ctx.configDir, 'presets');

const label = (p: string[]): string => p.join('.');
/** yaml writes a comment as `#` + text: each line gets its space. */
const comment = (text: string): string => text.split('\n').map((l) => ` ${l}`).join('\n');

/** Removes the paths from the document; returns those that were there. */
function strip(doc: YAML.Document, paths: string[][]): string[] {
  const removed: string[] = [];
  for (const p of paths) {
    if (!doc.hasIn(p)) continue;
    const v = doc.getIn(p);
    doc.deleteIn(p);
    // Only what had a value is worth naming in the header.
    if (v !== null && v !== '' && !(YAML.isCollection(v) && !v.items.length)) removed.push(label(p));
  }
  return removed;
}

/** The store's «settings of the project, edits are picked up» line (any language) does not belong in an export. */
function parseProjectText(text: string): YAML.Document {
  const headers = Object.values(coreMessages['projects.yamlHeader']);
  const nl = text.indexOf('\n');
  const first = (nl < 0 ? text : text.slice(0, nl)).trim();
  return YAML.parseDocument(headers.includes(first) ? text.slice(nl + 1) : text);
}

/** Built-in preset a project most likely came from: «Odoo в Docker» runs the official image, DEMZ is named so. */
export function guessBase(cfg: Record<string, unknown>): PresetId {
  const runtime = (cfg.runtime ?? {}) as { image?: unknown };
  if (typeof runtime.image === 'string' && /^odoo:/.test(runtime.image)) return 'odoo';
  const repo = (cfg.repo ?? {}) as { url?: unknown };
  if (cfg.id === 'demz' || (typeof repo.url === 'string' && /demz/i.test(repo.url))) return 'demz';
  return 'generic';
}

function projectText(ctx: Ctx, projectId: string): { text: string; config: Record<string, unknown> } {
  const e = ctx.store.get(projectId);
  if (!e?.config) throw new BmError('NO_PROJECT', t('projects.notFoundOrBroken', { id: projectId }));
  return { text: e.text, config: e.config as unknown as Record<string, unknown> };
}

/** YAML of the project for another machine (projects.export). */
export function exportProjectText(text: string, opts: { keepPaths: boolean; projectId: string }): string {
  const doc = parseProjectText(text);
  const removed = [...strip(doc, SECRET_PATHS), ...(opts.keepPaths ? [] : strip(doc, MACHINE_PATHS))];
  doc.commentBefore = comment(t('presets.exportHeader', { id: opts.projectId, at: nowIso(), removed: removed.join(', ') || '—' }));
  return doc.toString({ lineWidth: 120 });
}

export function exportProject(ctx: Ctx, p: { projectId: string; path: string; keepPaths: boolean }): { path: string } {
  if (!path.isAbsolute(p.path)) throw new BmError('BAD_PATH', t('presets.relative', { path: p.path }));
  const text = exportProjectText(projectText(ctx, p.projectId).text, p);
  fs.mkdirSync(path.dirname(p.path), { recursive: true });
  fs.writeFileSync(p.path, text, 'utf8');
  audit(ctx, { projectId: p.projectId, action: 'project.export', target: p.path, params: { keepPaths: p.keepPaths } });
  return { path: p.path };
}

/** File name of a preset: latin letters and digits of its name, or a time stamp. */
export function presetFileName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${slug || `preset-${Date.now()}`}.yaml`;
}

export function presetText(projectText: string, info: { name: string; base: PresetId; from: string }): string {
  const doc = parseProjectText(projectText);
  strip(doc, [...SECRET_PATHS, ...MACHINE_PATHS, ...IDENTITY_PATHS]);
  const out = new YAML.Document({ preset: { name: info.name, base: info.base, from: info.from, savedAt: nowIso() } });
  out.setIn(['config'], doc.contents);
  out.commentBefore = comment(t('presets.presetHeader', { name: info.name }));
  return out.toString({ lineWidth: 120 });
}

export function savePreset(ctx: Ctx, p: { projectId: string; name: string; base?: PresetId }): PresetInfo {
  const e = projectText(ctx, p.projectId);
  const base = p.base ?? guessBase(e.config);
  const file = presetFileName(p.name);
  fs.mkdirSync(presetsDir(ctx), { recursive: true });
  fs.writeFileSync(path.join(presetsDir(ctx), file), presetText(e.text, { name: p.name, base, from: p.projectId }), 'utf8');
  audit(ctx, { projectId: p.projectId, action: 'preset.save', target: file, params: { name: p.name, base } });
  return { file, name: p.name, base, from: p.projectId, savedAt: nowIso() };
}

/** Reads a preset or an exported project; secrets are dropped even if a hand-made file has them. */
export function parsePresetFile(text: string, file: string): PresetOverlay {
  let raw: unknown;
  try {
    raw = YAML.parse(text, { merge: true });
  } catch (err) {
    throw new BmError('PRESET_INVALID', t('presets.notYaml', { file, error: (err as Error).message }));
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BmError('PRESET_INVALID', t('presets.notConfig', { file }));
  const obj = raw as Record<string, unknown>;
  const wrapped = obj.preset && typeof obj.preset === 'object' && obj.config && typeof obj.config === 'object';
  const config = structuredClone((wrapped ? obj.config : obj) as Record<string, unknown>);
  if (Array.isArray(config)) throw new BmError('PRESET_INVALID', t('presets.notConfig', { file }));
  for (const p of SECRET_PATHS) {
    const parent = p.slice(0, -1).reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), config);
    if (parent && typeof parent === 'object') delete (parent as Record<string, unknown>)[p[p.length - 1]!];
  }
  if (wrapped) {
    const meta = obj.preset as { name?: unknown; base?: unknown };
    const base = PRESET_IDS.includes(meta.base as PresetId) ? (meta.base as PresetId) : guessBase(config);
    return { kind: 'preset', name: typeof meta.name === 'string' && meta.name ? meta.name : path.basename(file), base, config };
  }
  if (!('runtime' in config) && !('stages' in config) && !('repo' in config)) throw new BmError('PRESET_INVALID', t('presets.notConfig', { file }));
  return { kind: 'project', name: typeof config.name === 'string' ? config.name : path.basename(file), base: guessBase(config), config };
}

/** presets.read: a saved preset by `file`, or any file the user picked by `path`. */
export function readPreset(ctx: Ctx, p: { file?: string; path?: string }): PresetOverlay {
  const full = p.file ? presetPath(ctx, p.file) : p.path;
  if (!full || !path.isAbsolute(full)) throw new BmError('BAD_PATH', t('presets.relative', { path: full ?? '' }));
  let st: fs.Stats;
  try {
    st = fs.statSync(full);
  } catch {
    throw new BmError('PRESET_MISSING', t('presets.missing', { file: full }));
  }
  if (st.size > MAX_BYTES) throw new BmError('PRESET_INVALID', t('presets.tooBig', { file: full }));
  return parsePresetFile(fs.readFileSync(full, 'utf8'), full);
}

function presetPath(ctx: Ctx, file: string): string {
  if (!FILE_RE.test(file)) throw new BmError('BAD_PATH', t('presets.badName', { file }));
  return path.join(presetsDir(ctx), file);
}

export function listPresets(ctx: Ctx): PresetInfo[] {
  const dir = presetsDir(ctx);
  if (!fs.existsSync(dir)) return [];
  const out: PresetInfo[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => FILE_RE.test(f)).sort()) {
    try {
      const raw = YAML.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as { preset?: { name?: unknown; base?: unknown; from?: unknown; savedAt?: unknown } } | null;
      const meta = raw?.preset;
      if (!meta) continue;
      out.push({
        file,
        name: typeof meta.name === 'string' && meta.name ? meta.name : file,
        base: PRESET_IDS.includes(meta.base as PresetId) ? (meta.base as PresetId) : 'generic',
        from: typeof meta.from === 'string' ? meta.from : null,
        savedAt: typeof meta.savedAt === 'string' ? meta.savedAt : null,
      });
    } catch {
      /* a broken file is skipped: the list stays usable */
    }
  }
  return out;
}

export function deletePreset(ctx: Ctx, file: string): void {
  const full = presetPath(ctx, file);
  fs.rmSync(full, { force: true });
  audit(ctx, { action: 'preset.delete', target: file });
}
