import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import YAML from 'yaml';
import { appConfigSchema, BmError, projectConfigSchema, type AppConfig, type ProjectConfig } from '@bm/shared';
import { literalPrefix, renderTemplate, templateToRegex } from './templates';
import { expandPath } from '../util/paths';
import { log } from '../util/logger';

export interface ProjectEntry {
  id: string;
  path: string;
  text: string;
  config: ProjectConfig | null;
  error: string | null;
}

const hash = (s: string): string => crypto.createHash('sha1').update(s).digest('hex');

/** Reads, validates and writes the YAML settings files (spec 9.1) and reloads them on manual edits. */
export class ConfigStore {
  readonly appFile: string;
  readonly projectsDir: string;
  app: AppConfig;
  appExists = false;
  private projects = new Map<string, ProjectEntry>();
  private ownWrites = new Map<string, string>();
  private watcher: FSWatcher | null = null;

  constructor(readonly configDir: string) {
    this.appFile = path.join(configDir, 'app.yaml');
    this.projectsDir = path.join(configDir, 'projects');
    this.app = appConfigSchema.parse({});
  }

  load(): void {
    fs.mkdirSync(this.projectsDir, { recursive: true });
    this.loadApp();
    this.projects.clear();
    for (const f of fs.readdirSync(this.projectsDir)) {
      if (!f.endsWith('.yaml')) continue;
      this.loadProjectFile(path.join(this.projectsDir, f));
    }
  }

  private loadApp(): void {
    this.appExists = fs.existsSync(this.appFile);
    if (!this.appExists) {
      this.app = appConfigSchema.parse({});
      return;
    }
    try {
      this.app = appConfigSchema.parse(YAML.parse(fs.readFileSync(this.appFile, 'utf8')) ?? {});
    } catch (err) {
      log().error({ err }, 'app.yaml invalid, using defaults');
      this.app = appConfigSchema.parse({});
    }
  }

  private loadProjectFile(file: string): ProjectEntry {
    const id = path.basename(file, '.yaml');
    const text = fs.readFileSync(file, 'utf8');
    let entry: ProjectEntry;
    try {
      const cfg = parseProjectYaml(text);
      if (cfg.id !== id) throw new BmError('CONFIG_ID', `id «${cfg.id}» не совпадает с именем файла ${id}.yaml`);
      entry = { id, path: file, text, config: cfg, error: null };
    } catch (err) {
      entry = { id, path: file, text, config: null, error: (err as Error).message };
    }
    this.projects.set(id, entry);
    return entry;
  }

  dataDir(override: string | null): string {
    return override ? path.resolve(override) : expandPath(this.app.dataDir);
  }

  list(): ProjectEntry[] {
    return [...this.projects.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): ProjectEntry | undefined {
    return this.projects.get(id);
  }

  /** Throws a user-facing error if the project is missing or its YAML is invalid. */
  require(id: string): ProjectConfig {
    const e = this.projects.get(id);
    if (!e) throw new BmError('NO_PROJECT', `Проект «${id}» не найден`);
    if (!e.config) throw new BmError('CONFIG_INVALID', `Настройки проекта «${id}» содержат ошибку: ${e.error}. Исправьте ${e.path}.`);
    return e.config;
  }

  /** Validates and writes a project file. Cross-project name collisions are rejected (spec 11). */
  putProject(text: string, opts: { expectId?: string; create?: boolean }): ProjectConfig {
    const cfg = parseProjectYaml(text);
    if (opts.expectId && cfg.id !== opts.expectId) {
      throw new BmError('CONFIG_ID', `Нельзя менять id проекта (${opts.expectId} → ${cfg.id}). Создайте новый проект.`);
    }
    if (opts.create && this.projects.has(cfg.id)) {
      throw new BmError('PROJECT_EXISTS', `Проект с id «${cfg.id}» уже есть. Выберите другой id.`);
    }
    const others = this.list().filter((e) => e.id !== cfg.id && e.config).map((e) => e.config!);
    checkCrossProject(cfg, others);
    const file = path.join(this.projectsDir, `${cfg.id}.yaml`);
    this.writeFile(file, text);
    this.loadProjectFile(file);
    return cfg;
  }

  deleteProject(id: string): void {
    const e = this.projects.get(id);
    if (!e) return;
    // Full cleanup (D34): the settings file goes too, no `.deleted-<time>` copy.
    fs.rmSync(e.path, { force: true });
    this.projects.delete(id);
  }

  /** Patches app.yaml, keeping comments and formatting of the existing file. */
  updateApp(patch: (doc: YAML.Document) => void): AppConfig {
    const text = fs.existsSync(this.appFile) ? fs.readFileSync(this.appFile, 'utf8') : '';
    const doc = text ? YAML.parseDocument(text) : new YAML.Document({});
    patch(doc);
    const next = appConfigSchema.parse(doc.toJS() ?? {});
    this.writeFile(this.appFile, doc.toString());
    this.app = next;
    this.appExists = true;
    return next;
  }

  putAppYaml(text: string): AppConfig {
    const next = appConfigSchema.parse(YAML.parse(text) ?? {});
    this.writeFile(this.appFile, text);
    this.app = next;
    this.appExists = true;
    return next;
  }

  appText(): string {
    return fs.existsSync(this.appFile) ? fs.readFileSync(this.appFile, 'utf8') : YAML.stringify(this.app);
  }

  private writeFile(file: string, text: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
    this.ownWrites.set(path.resolve(file).toLowerCase(), hash(text));
  }

  /** Picks up hand edits of the YAML files (spec 9.1). */
  watch(onChange: (what: { app: boolean; projectIds: string[] }) => void): void {
    this.watcher?.close();
    let timer: NodeJS.Timeout | null = null;
    const changed = new Set<string>();
    this.watcher = chokidar.watch([this.appFile, this.projectsDir], { ignoreInitial: true, depth: 0, awaitWriteFinish: { stabilityThreshold: 200 } });
    const handler = (file: string): void => {
      if (!file.endsWith('.yaml')) return;
      const key = path.resolve(file).toLowerCase();
      const own = this.ownWrites.get(key);
      if (own && fs.existsSync(file) && hash(fs.readFileSync(file, 'utf8')) === own) return;
      changed.add(file);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const files = [...changed];
        changed.clear();
        let app = false;
        const ids: string[] = [];
        for (const f of files) {
          if (path.resolve(f).toLowerCase() === path.resolve(this.appFile).toLowerCase()) {
            this.loadApp();
            app = true;
          } else if (fs.existsSync(f)) {
            ids.push(this.loadProjectFile(f).id);
          } else {
            const id = path.basename(f, '.yaml');
            this.projects.delete(id);
            ids.push(id);
          }
        }
        onChange({ app, projectIds: ids });
      }, 300);
    };
    this.watcher.on('add', handler).on('change', handler).on('unlink', handler);
  }

  close(): void {
    void this.watcher?.close();
  }
}

export function parseProjectYaml(text: string): ProjectConfig {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (err) {
    throw new BmError('YAML_SYNTAX', `Ошибка синтаксиса YAML: ${(err as Error).message}`);
  }
  const cfg = projectConfigSchema.parse(raw ?? {});
  validateProject(cfg);
  return cfg;
}

/** Checks that do not fit zod: templates render, regexes compile, the DB name prefix is unambiguous. */
export function validateProject(cfg: ProjectConfig): void {
  const sample = { project: cfg.id, branch: 'x', slug: 'sample', slug_: 'sample', build: 1, stage: 'development' };
  const tryRender = (tpl: string, field: string): string => {
    try {
      return renderTemplate(tpl, sample);
    } catch (err) {
      throw new BmError('CONFIG_TEMPLATE', `${field}: ${(err as Error).message}`);
    }
  };
  const db = tryRender(cfg.naming.db, 'naming.db');
  if (!/^[a-z0-9_]+$/.test(db)) throw new BmError('CONFIG_TEMPLATE', `naming.db даёт недопустимое имя БД «${db}»: только a-z, 0-9, «_»`);
  if (!cfg.naming.db.includes('{build}')) throw new BmError('CONFIG_TEMPLATE', 'naming.db должен содержать {build}: у каждой сборки своя БД');
  if (literalPrefix(cfg.naming.db).length < 3) {
    throw new BmError('CONFIG_TEMPLATE', 'naming.db должен начинаться с постоянного префикса не короче 3 символов (например o19_br_): по нему приложение узнаёт свои БД');
  }
  for (const p of cfg.postgres.protectedDbs) {
    if (templateToRegex(cfg.naming.db).test(p)) throw new BmError('CONFIG_TEMPLATE', `naming.db может совпасть с защищённой БД «${p}»`);
  }
  tryRender(cfg.naming.host, 'naming.host');
  tryRender(cfg.naming.composeProject, 'naming.composeProject');
  for (const [field, re] of [
    ['naming.slugStrip', cfg.naming.slugStrip],
    ['naming.parse', cfg.naming.parse],
    ['naming.branch.nameRegex', cfg.naming.branch.nameRegex],
  ] as const) {
    if (!re) continue;
    try {
      new RegExp(re);
    } catch (err) {
      throw new BmError('CONFIG_REGEX', `${field}: неверное регулярное выражение (${(err as Error).message})`);
    }
  }
}

/** Resource names of different projects must never collide (spec 8.1, 11). */
export function checkCrossProject(cfg: ProjectConfig, others: ProjectConfig[]): void {
  for (const o of others) {
    const a = literalPrefix(cfg.naming.db);
    const b = literalPrefix(o.naming.db);
    if (a.startsWith(b) || b.startsWith(a)) {
      throw new BmError('CONFIG_CONFLICT', `Шаблон naming.db («${cfg.naming.db}») пересекается с проектом «${o.id}» («${o.naming.db}»). Задайте другой префикс.`);
    }
    const samples = ['crm', 'prod', 'a-b', 'dev', cfg.id, o.id];
    for (const [tplA, tplB, field] of [
      [cfg.naming.host, o.naming.host, 'naming.host'],
      [cfg.naming.composeProject, o.naming.composeProject, 'naming.composeProject'],
    ] as const) {
      const reB = templateToRegex(tplB.replace('{project}', o.id));
      const reA = templateToRegex(tplA.replace('{project}', cfg.id));
      for (const s of samples) {
        const va = renderTemplate(tplA, { project: cfg.id, slug: s, slug_: s.replace(/-/g, '_') });
        const vb = renderTemplate(tplB, { project: o.id, slug: s, slug_: s.replace(/-/g, '_') });
        if (reB.test(va) || reA.test(vb)) {
          throw new BmError('CONFIG_CONFLICT', `${field} («${tplA}») может совпасть с проектом «${o.id}» («${tplB}»). Добавьте {project} или другой суффикс.`);
        }
      }
    }
  }
}
