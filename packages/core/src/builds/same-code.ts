import fs from 'node:fs';
import { and, eq, inArray } from 'drizzle-orm';
import type { ProjectConfig, ResolvedBranchScope } from '@bm/shared';
import type { Ctx } from '../context';
import { builds, type BranchRow, type BuildRow } from '../db/schema';
import * as git from '../git';
import { changedModules, modulesFromTree, parseModuleList, selectTestModules } from '../modules';
import { audit } from '../services/audit';
import { bus } from '../events';
import { log } from '../util/logger';
import { nowIso } from '../util/time';
import { testsFailed } from './odoo-cli';
import { folderCodeState, sameCode, testsCover, type CodeState } from './code-state';
import { t } from '../i18n';

/**
 * Modules the tests step of an `update` build of `sha` would test (spec 8.8), without the «installed» filter (it needs
 * the database; without it the set can only be larger, so nothing is skipped by mistake).
 */
async function modulesToTest(cfg: ProjectConfig, scope: ResolvedBranchScope, folder: string, live: BuildRow, sha: string): Promise<string[] | null> {
  const mode = scope.tests.mode;
  if (mode === 'none') return [];
  let changed: string[] = [];
  if (mode === 'changed') {
    if (!live.commitSha || !(await git.revParse(folder, live.commitSha))) return null;
    const files = [...new Set([...(await git.diffNames(folder, live.commitSha, sha)), ...(await git.uncommittedFiles(folder))])];
    const to = modulesFromTree(await git.lsTree(folder, sha));
    const from = modulesFromTree(await git.lsTree(folder, live.commitSha));
    changed = changedModules(files, to, from, cfg.repo.moduleRoots).changed.map((m) => m.name);
  }
  const wantedText = cfg.repo.modulesToInstall ? await git.showFile(folder, sha, cfg.repo.modulesToInstall) : null;
  return selectTestModules(mode, { changed, wanted: wantedText ? parseModuleList(wantedText) : [] });
}

/**
 * The state of the user's folder when a new commit needs no build (D76), null — it does: the folder holds exactly the
 * code the live build's database already got (manual `-u` included), and the tests the update would run already passed
 * on it. Failed tests go through the build: it does not rerun them but fails and notifies as before.
 */
async function sameCodeAsLive(cfg: ProjectConfig, scope: ResolvedBranchScope, folder: string, live: BuildRow, sha: string): Promise<CodeState | null> {
  if (!live.codeState) return null;
  const now = await folderCodeState(folder, cfg.repo.moduleRoots);
  if (!sameCode(now, live.codeState)) return null;
  const mods = await modulesToTest(cfg, scope, folder, live, sha);
  if (!mods) return null;
  if (mods.length && !(live.tests && !testsFailed(live.tests) && testsCover(live.testedCode, now, mods))) return null;
  return now;
}

/**
 * New commit of a folder branch with `onNewCommit: update` (D76): when its code is what the live build already runs
 * and tested, the live build is only marked with the commit — no build, the container keeps running. Returns whether
 * it did so; any doubt (or error) leaves the decision to the usual build.
 */
export async function markLiveWithCommit(ctx: Ctx, cfg: ProjectConfig, b: BranchRow, scope: ResolvedBranchScope, live: BuildRow, sha: string): Promise<boolean> {
  if (!scope.folder) return false;
  const active = ctx.db.select().from(builds).where(and(eq(builds.branchId, b.id), inArray(builds.status, ['queued', 'building']))).get();
  if (active) return false;
  const folder = scope.folder;
  let now: CodeState | null;
  try {
    now = await sameCodeAsLive(cfg, scope, folder, live, sha);
  } catch (err) {
    log().warn({ err, branch: b.name }, 'same-code check failed, building as usual');
    return false;
  }
  if (!now) return false;
  const known = !!live.commitSha && !!(await git.revParse(folder, live.commitSha).catch(() => null));
  const added = await git.commitsBetween(folder, known ? live.commitSha : null, sha, known ? 200 : 1).catch(() => []);
  const commits = [...added, ...(live.commits ?? []).filter((c) => !added.some((a) => a.sha === c.sha))].slice(0, 200);
  ctx.db.update(builds).set({ commitSha: sha, commits, codeState: now }).where(eq(builds.id, live.id)).run();
  const line = t('same.marked', { sha: sha.slice(0, 7), number: live.number, time: nowIso() });
  if (live.logPath) fs.promises.appendFile(live.logPath, `${line}\n`).catch(() => {});
  log().info({ branch: b.name, sha, build: live.number }, 'same code as the live build: marked, not rebuilt');
  audit(ctx, { projectId: cfg.id, action: 'build.sameCode', target: `${b.name}#${live.number}`, params: { sha, from: live.commitSha } });
  bus.emit({ type: 'build.changed', projectId: cfg.id, branchId: b.id, buildId: live.id });
  bus.emit({ type: 'branch.changed', projectId: cfg.id, branchId: b.id });
  return true;
}
