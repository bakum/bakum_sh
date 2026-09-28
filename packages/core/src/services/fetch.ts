import { eq } from 'drizzle-orm';
import { isLegacyProject, type ProjectConfig } from '@bm/shared';
import type { Ctx } from '../context';
import { branches, projects, type JobRow } from '../db/schema';
import * as git from '../git';
import { shouldAutoAdd } from '../config/rules';
import { resolveBranchScope } from '../config/effective';
import { bus } from '../events';
import { getQueue, type JobContext } from '../jobs/queue';
import { applyRules, gitBranches, recordHeads } from './branches';
import { branchByName, branchRows, ensureBranchRow, isAutoAddSkipped } from './branch-rows';
import { onNewCommit } from '../builds/triggers';
import { requestBuildChecked } from '../builds/request';
import { audit } from './audit';
import { repoDir } from '../git/worktrees';
import { assertNotLegacy } from '../config/legacy';
import { log } from '../util/logger';
import { nowIso } from '../util/time';

/** Job `fetch`: git fetch → auto-add by rules → rules re-applied → new commits trigger builds (spec 8.2, 8.3). */
export async function fetchExecutor(ctx: Ctx, job: JobRow, jc: JobContext): Promise<void> {
  const cfg = ctx.store.require(job.projectId!);
  assertNotLegacy(cfg);
  let fetchError: string | null = null;
  try {
    jc.log(`git fetch ${cfg.repo.remote} in ${repoDir(cfg)}`);
    await git.fetch(repoDir(cfg), cfg.repo.remote);
  } catch (err) {
    fetchError = (err as Error).message;
    jc.log(`fetch failed: ${fetchError}`);
  }
  ctx.db.update(projects).set({ lastFetchAt: nowIso(), lastFetchError: fetchError }).where(eq(projects.id, cfg.id)).run();
  await processRefs(ctx, cfg, jc);
  bus.emit({ type: 'project.changed', projectId: cfg.id });
  if (fetchError) throw new Error(`git fetch: ${fetchError}`);
}

export async function processRefs(ctx: Ctx, cfg: ProjectConfig, jc?: JobContext): Promise<void> {
  const known = await gitBranches(ctx, cfg, true);
  // Auto-add new branches (autoAddBranches + branchRules; ignore always wins).
  for (const g of known) {
    if (branchByName(ctx, cfg.id, g.name) || isAutoAddSkipped(ctx, cfg.id, g.name)) continue;
    const sel = shouldAutoAdd(cfg, g.name);
    if (!sel || sel.stage === 'ignore') continue;
    const row = ensureBranchRow(ctx, cfg, g.name, sel.stage, 'rule');
    await recordHeads(ctx, cfg, row);
    jc?.log(`added ${g.name} → ${sel.stage}`);
    audit(ctx, { projectId: cfg.id, action: 'branch.autoAdd', target: g.name, params: { stage: sel.stage, rule: sel.ruleIndex } });
    const scope = resolveBranchScope(cfg, row.name, row.stage, row.overrides).scope;
    if (scope.buildOnAdd) await requestBuildChecked(ctx, row.id, { trigger: 'manual' }).catch((e) => jc?.log(`build on add: ${(e as Error).message}`));
  }
  applyRules(ctx, cfg);
  // New commits on the remote for branches built from the mirror (branches with their own folder follow the folder).
  for (const b of branchRows(ctx, cfg.id)) {
    const sha = await git.remoteSha(repoDir(cfg), cfg.repo.remote, b.name);
    if (!sha || sha === b.lastSeenRemoteSha) continue;
    const prev = b.lastSeenRemoteSha;
    ctx.db.update(branches).set({ lastSeenRemoteSha: sha }).where(eq(branches.id, b.id)).run();
    const scope = resolveBranchScope(cfg, b.name, b.stage, b.overrides).scope;
    if (scope.folder || !prev) continue;
    const forcePush = !(await git.isAncestor(repoDir(cfg), prev, sha));
    jc?.log(`${b.name}: ${prev.slice(0, 7)} → ${sha.slice(0, 7)}${forcePush ? ' (force-push)' : ''}`);
    await onNewCommit(ctx, cfg, { ...b, lastSeenRemoteSha: sha }, sha, { forcePush });
    bus.emit({ type: 'branch.changed', projectId: cfg.id, branchId: b.id });
  }
}

const timers = new Map<string, NodeJS.Timeout>();

/** Periodic fetch per project (repo.fetchIntervalMin; 0 = manual only; disabled projects are skipped). */
export function scheduleFetches(ctx: Ctx): void {
  for (const t of timers.values()) clearInterval(t);
  timers.clear();
  for (const e of ctx.store.list()) {
    const cfg = e.config;
    if (!cfg || !cfg.enabled || !cfg.repo.fetchIntervalMin || isLegacyProject(cfg)) continue;
    const ms = cfg.repo.fetchIntervalMin * 60_000;
    timers.set(
      cfg.id,
      setInterval(() => {
        try {
          getQueue().enqueue('fetch', { projectId: cfg.id }, { auto: true });
        } catch (err) {
          log().warn({ err }, 'scheduled fetch failed');
        }
      }, ms),
    );
  }
}

export function requestFetch(ctx: Ctx, projectId?: string): number[] {
  const ids = projectId ? [projectId] : ctx.store.list().filter((e) => e.config?.enabled && !isLegacyProject(e.config)).map((e) => e.id);
  return ids.map((id) => {
    assertNotLegacy(ctx.store.require(id));
    return getQueue().enqueue('fetch', { projectId: id }, { manual: true });
  });
}

export function stopFetches(): void {
  for (const t of timers.values()) clearInterval(t);
  timers.clear();
}
