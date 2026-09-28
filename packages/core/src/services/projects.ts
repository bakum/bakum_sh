import { eq } from 'drizzle-orm';
import YAML from 'yaml';
import { BmError, type ProjectConfig, type ProjectSummary } from '@bm/shared';
import type { Ctx } from '../context';
import { projects } from '../db/schema';
import { bus } from '../events';
import { detectedPassword } from '../detect';
import { audit, lineDiff } from './audit';
import { ensureBranchRow, relayoutProductionBranch } from './branch-rows';
import { nowIso } from '../util/time';

export const PASSWORD_MASK = '********';

/** Registry rows mirror the YAML projects (name, paths); created on first sight. */
export function syncProjectRows(ctx: Ctx): void {
  for (const e of ctx.store.list()) {
    const row = ctx.db.select().from(projects).where(eq(projects.id, e.id)).get();
    const cfg = e.config;
    if (!row) {
      ctx.db
        .insert(projects)
        .values({
          id: e.id,
          name: cfg?.name ?? e.id,
          configPath: e.path,
          repoPath: cfg?.repo.path ?? '',
          enabled: cfg?.enabled ?? true,
          createdAt: nowIso(),
        })
        .run();
    } else if (cfg) {
      ctx.db.update(projects).set({ name: cfg.name, repoPath: cfg.repo.path, enabled: cfg.enabled, configPath: e.path }).where(eq(projects.id, e.id)).run();
    }
    if (cfg) ensureBranchRow(ctx, cfg, cfg.production.branch, 'production', 'rule');
  }
}

export function summaries(ctx: Ctx): ProjectSummary[] {
  return ctx.store.list().map((e) => summary(ctx, e.id));
}

export function summary(ctx: Ctx, id: string): ProjectSummary {
  const e = ctx.store.get(id);
  if (!e) throw new BmError('NO_PROJECT', `Проект «${id}» не найден`);
  const row = ctx.db.select().from(projects).where(eq(projects.id, id)).get();
  return {
    id,
    name: e.config?.name ?? id,
    repoPath: e.config?.repo.path ?? row?.repoPath ?? '',
    enabled: e.config?.enabled ?? false,
    configPath: e.path,
    configError: e.error,
    github: e.config?.repo.github ?? null,
    odooVersion: e.config?.runtime.odooVersion ?? '',
    lastFetchAt: row?.lastFetchAt ?? null,
    lastFetchError: row?.lastFetchError ?? null,
  };
}

/** YAML for the renderer: the Postgres password never leaves Core (spec 11). */
export function maskedYaml(text: string): string {
  const doc = YAML.parseDocument(text);
  if (doc.hasIn(['postgres', 'password']) && doc.getIn(['postgres', 'password'])) doc.setIn(['postgres', 'password'], PASSWORD_MASK);
  return doc.toString();
}

export function maskedConfig(cfg: ProjectConfig): ProjectConfig {
  return { ...cfg, postgres: { ...cfg.postgres, password: cfg.postgres.password ? PASSWORD_MASK : '' } };
}

function unmask(text: string, previousPassword: string | null): string {
  const doc = YAML.parseDocument(text);
  const pw = doc.getIn(['postgres', 'password']);
  if (pw === PASSWORD_MASK) doc.setIn(['postgres', 'password'], previousPassword ?? '');
  return doc.toString();
}

export function getProject(ctx: Ctx, id: string) {
  const e = ctx.store.get(id);
  if (!e) throw new BmError('NO_PROJECT', `Проект «${id}» не найден`);
  const cfg = e.config;
  return {
    summary: summary(ctx, id),
    config: cfg ? maskedConfig(cfg) : (null as unknown as ProjectConfig),
    yaml: maskedYaml(e.text),
  };
}

export function createProject(ctx: Ctx, yaml: string): ProjectSummary {
  const doc = YAML.parseDocument(yaml);
  const repoPath = String(doc.getIn(['repo', 'path']) ?? '');
  const pw = doc.getIn(['postgres', 'password']);
  if (!pw || pw === PASSWORD_MASK) doc.setIn(['postgres', 'password'], detectedPassword(repoPath) ?? '');
  const text = `# Настройки проекта DEMZ Branch Manager. Правка файла подхватывается автоматически.\n${doc.toString()}`;
  const cfg = ctx.store.putProject(text, { create: true });
  syncProjectRows(ctx);
  audit(ctx, { projectId: cfg.id, action: 'project.create', target: cfg.id, params: { repo: cfg.repo.path } });
  bus.emit({ type: 'project.changed', projectId: cfg.id });
  return summary(ctx, cfg.id);
}

export function updateProject(ctx: Ctx, id: string, yaml: string): ProjectSummary {
  const prev = ctx.store.require(id);
  const prevText = ctx.store.get(id)!.text;
  const text = unmask(yaml, prev.postgres.password);
  const cfg = ctx.store.putProject(text, { expectId: id });
  onProjectConfigChanged(ctx, prev, cfg);
  audit(ctx, { projectId: id, action: 'settings.update', target: `${id}.yaml`, diff: lineDiff(maskedYaml(prevText), maskedYaml(text)) });
  return summary(ctx, id);
}

/** Reactions to a settings change (form, YAML editor or hand edit). */
/** Background services react to settings changes (fetch timers, rules). */
export const configChangeHooks: (() => void)[] = [];

export function onProjectConfigChanged(ctx: Ctx, prev: ProjectConfig | null, cfg: ProjectConfig): void {
  syncProjectRows(ctx);
  if (prev && prev.production.branch !== cfg.production.branch) relayoutProductionBranch(ctx, cfg, prev.production.branch);
  bus.emit({ type: 'project.changed', projectId: cfg.id });
  bus.emit({ type: 'config.changed', projectId: cfg.id });
  for (const h of configChangeHooks) h();
}

export function setEnabled(ctx: Ctx, id: string, enabled: boolean): ProjectSummary {
  const e = ctx.store.get(id);
  if (!e?.config) throw new BmError('NO_PROJECT', `Проект «${id}» не найден или его настройки с ошибкой`);
  const doc = YAML.parseDocument(e.text);
  doc.set('enabled', enabled);
  const cfg = ctx.store.putProject(doc.toString(), { expectId: id });
  onProjectConfigChanged(ctx, e.config, cfg);
  audit(ctx, { projectId: id, action: enabled ? 'project.enable' : 'project.disable', target: id });
  return summary(ctx, id);
}
