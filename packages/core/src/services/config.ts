import YAML from 'yaml';
import { z } from 'zod';
import { appConfigSchema, BmError, branchScopeSchema, projectConfigSchema, type EffectiveConfig, type Lang, type Level } from '@bm/shared';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import { branches } from '../db/schema';
import { resolveBranchScope } from '../config/effective';
import { bus } from '../events';
import { audit, lineDiff } from './audit';
import { branchRow } from './branch-rows';
import { localWatcher } from './watch-local';
import { getProject, updateProject } from './projects';
import { t } from '../i18n';

export function configGet(ctx: Ctx, p: { projectId?: string; level: Level; branchId?: number }): { yaml: string; value: unknown } {
  switch (p.level) {
    case 'app':
      return { yaml: ctx.store.appText(), value: ctx.store.app };
    case 'project': {
      if (!p.projectId) throw new BmError('BAD_PARAMS', t('config.noProject'));
      const r = getProject(ctx, p.projectId);
      return { yaml: r.yaml, value: r.config };
    }
    case 'stage': {
      if (!p.projectId) throw new BmError('BAD_PARAMS', t('config.noProject'));
      const cfg = ctx.store.require(p.projectId);
      return { yaml: YAML.stringify(cfg.stages), value: cfg.stages };
    }
    case 'rule': {
      if (!p.projectId) throw new BmError('BAD_PARAMS', t('config.noProject'));
      const cfg = ctx.store.require(p.projectId);
      return { yaml: YAML.stringify(cfg.branchRules), value: cfg.branchRules };
    }
    case 'branch': {
      const b = p.branchId ? branchRow(ctx, p.branchId) : undefined;
      if (!b) throw new BmError('NO_BRANCH', t('config.noBranch'));
      const ov = b.overrides ?? {};
      return { yaml: Object.keys(ov).length ? YAML.stringify(ov) : '{}\n', value: ov };
    }
  }
}

/** The header's language switch (D69): only `language` of app.yaml changes, the rest of the file and its comments stay. */
export function setLanguage(ctx: Ctx, language: Lang): { ok: true } {
  const prev = ctx.store.app.language;
  if (prev === language) return { ok: true };
  const next = ctx.store.updateApp((doc) => doc.set('language', language));
  audit(ctx, { action: 'settings.update', target: 'app.yaml', diff: `- language: ${prev}\n+ language: ${language}` });
  ctx.toMain({ kind: 'appConfig', config: next });
  bus.emit({ type: 'config.changed' });
  return { ok: true };
}

export function configPut(ctx: Ctx, p: { projectId?: string; level: Level; branchId?: number; yaml: string }): { ok: true } {
  switch (p.level) {
    case 'app': {
      const prev = ctx.store.appText();
      const next = ctx.store.putAppYaml(p.yaml);
      audit(ctx, { action: 'settings.update', target: 'app.yaml', diff: lineDiff(prev, p.yaml) });
      ctx.toMain({ kind: 'appConfig', config: next });
      bus.emit({ type: 'config.changed' });
      return { ok: true };
    }
    case 'project':
      if (!p.projectId) throw new BmError('BAD_PARAMS', t('config.noProject'));
      updateProject(ctx, p.projectId, p.yaml);
      return { ok: true };
    case 'branch': {
      const b = p.branchId ? branchRow(ctx, p.branchId) : undefined;
      if (!b) throw new BmError('NO_BRANCH', t('config.noBranch'));
      let raw: unknown;
      try {
        raw = YAML.parse(p.yaml) ?? {};
      } catch (err) {
        throw new BmError('YAML_SYNTAX', t('config.yamlSyntax', { error: (err as Error).message }));
      }
      setBranchOverrides(ctx, b.id, branchScopeSchema.parse(raw));
      return { ok: true };
    }
    default:
      throw new BmError('READ_ONLY', t('config.readOnly'));
  }
}

export function setBranchOverrides(ctx: Ctx, branchId: number, overrides: z.infer<typeof branchScopeSchema>): void {
  const b = branchRow(ctx, branchId);
  if (!b) throw new BmError('NO_BRANCH', t('config.noBranch'));
  const prev = YAML.stringify(b.overrides ?? {});
  const folderChanged = (b.overrides?.folder ?? null) !== (overrides.folder ?? null);
  // Another folder: its HEAD becomes the new starting point (LocalWatcher records it without triggering a build).
  ctx.db
    .update(branches)
    .set(folderChanged ? { overrides, lastSeenLocalSha: null } : { overrides })
    .where(eq(branches.id, branchId))
    .run();
  if (folderChanged) void localWatcher()?.sync();
  audit(ctx, { projectId: b.projectId, action: 'settings.branch', target: b.name, diff: lineDiff(prev, YAML.stringify(overrides)) });
  bus.emit({ type: 'branch.changed', projectId: b.projectId, branchId });
}

export function configEffective(ctx: Ctx, branchId: number): EffectiveConfig {
  const b = branchRow(ctx, branchId);
  if (!b) throw new BmError('NO_BRANCH', t('config.noBranch'));
  const cfg = ctx.store.require(b.projectId);
  const r = resolveBranchScope(cfg, b.name, b.stage, b.overrides);
  return { branchId, stage: b.stage, ruleIndex: r.ruleIndex, scope: r.scope, fields: r.fields, branchOverrides: b.overrides ?? {} };
}

let schemas: { project: unknown; app: unknown; branch: unknown } | null = null;
export function jsonSchemas() {
  schemas ??= {
    project: z.toJSONSchema(projectConfigSchema, { io: 'input', unrepresentable: 'any' }),
    app: z.toJSONSchema(appConfigSchema, { io: 'input', unrepresentable: 'any' }),
    branch: z.toJSONSchema(branchScopeSchema, { io: 'input', unrepresentable: 'any' }),
  };
  return schemas;
}
