import { and, eq } from 'drizzle-orm';
import type { ProjectConfig, Stage } from '@bm/shared';
import type { Ctx } from '../context';
import { branches, type BranchRow } from '../db/schema';
import { makeSlug, parseBranchName } from '../config/templates';
import { nowIso } from '../util/time';

export function branchRows(ctx: Ctx, projectId: string): BranchRow[] {
  return ctx.db.select().from(branches).where(eq(branches.projectId, projectId)).all();
}

export function branchRow(ctx: Ctx, id: number): BranchRow | undefined {
  return ctx.db.select().from(branches).where(eq(branches.id, id)).get();
}

export function branchByName(ctx: Ctx, projectId: string, name: string): BranchRow | undefined {
  return ctx.db.select().from(branches).where(and(eq(branches.projectId, projectId), eq(branches.name, name))).get();
}

export function slugFor(ctx: Ctx, cfg: ProjectConfig, name: string, stage: Stage, exceptId?: number): string {
  if (stage === 'production') return cfg.production.slug;
  const taken = branchRows(ctx, cfg.id)
    .filter((b) => b.id !== exceptId)
    .map((b) => b.slug);
  taken.push(cfg.production.slug);
  const parsed = parseBranchName(name, cfg.naming.parse);
  return makeSlug(name, { template: cfg.naming.slug, strip: cfg.naming.slugStrip, vars: parsed, taken });
}

/** Adds a branch to the project (or returns the existing row). The production branch always gets production.slug. */
export function ensureBranchRow(ctx: Ctx, cfg: ProjectConfig, name: string, stage: Stage, assignedBy: 'user' | 'rule'): BranchRow {
  const existing = branchByName(ctx, cfg.id, name);
  if (existing) {
    if (stage === 'production' && (existing.stage !== 'production' || existing.slug !== cfg.production.slug)) {
      ctx.db.update(branches).set({ stage: 'production', slug: cfg.production.slug, assignedBy: 'rule' }).where(eq(branches.id, existing.id)).run();
      return branchRow(ctx, existing.id)!;
    }
    return existing;
  }
  const slug = slugFor(ctx, cfg, name, stage);
  const res = ctx.db
    .insert(branches)
    .values({ projectId: cfg.id, name, slug, stage, assignedBy, overrides: {}, createdAt: nowIso(), stageChangedAt: nowIso() })
    .returning()
    .get();
  return res;
}

/**
 * production.branch changed: the old production branch moves to Staging (spec 6), gets a regular slug,
 * the new one takes production.slug.
 */
export function relayoutProductionBranch(ctx: Ctx, cfg: ProjectConfig, oldName: string): void {
  const old = branchByName(ctx, cfg.id, oldName);
  if (old && old.stage === 'production') {
    const slug = slugFor(ctx, cfg, oldName, 'staging', old.id);
    ctx.db.update(branches).set({ stage: 'staging', slug, assignedBy: 'user', stageChangedAt: nowIso() }).where(eq(branches.id, old.id)).run();
  }
  const next = branchByName(ctx, cfg.id, cfg.production.branch);
  if (next) {
    ctx.db.update(branches).set({ stage: 'production', slug: cfg.production.slug, assignedBy: 'rule', stageChangedAt: nowIso() }).where(eq(branches.id, next.id)).run();
  } else ensureBranchRow(ctx, cfg, cfg.production.branch, 'production', 'rule');
}
