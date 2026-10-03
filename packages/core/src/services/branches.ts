import { eq } from 'drizzle-orm';
import YAML from 'yaml';
import {
  BmError,
  type BranchBadge,
  type BranchesList,
  type BranchView,
  type GitBranchInfo,
  type LiveIndicator,
  type ProjectConfig,
  type Stage,
  type UnassignedBranch,
} from '@bm/shared';
import type { Ctx } from '../context';
import { branches, type BranchRow, type BuildRow } from '../db/schema';
import * as git from '../git';
import { selectStage } from '../config/rules';
import { renderTemplate } from '../config/templates';
import { resolveBranchScope } from '../config/effective';
import { bus } from '../events';
import { audit } from './audit';
import { branchByName, branchRow, branchRows, ensureBranchRow, setAutoAddSkip } from './branch-rows';
import { branchBuilds, buildUrl, configHash, liveBuild, toBuildView } from '../builds/view';
import { requestBuildChecked } from '../builds/request';
import { repoDir, worktreeHeadSync } from '../git/worktrees';
import { assertNotLegacy } from '../config/legacy';
import { onProjectConfigChanged } from './projects';
import { nowIso } from '../util/time';
import { codeLagOf, lagBadge } from './code-lag';
import { localWatcher } from './watch-local';
import { runtimeState } from '../state';
import { t } from '../i18n';

/** Branch names known to git per project, refreshed by fetch. */
const gitCache = new Map<string, GitBranchInfo[]>();

export async function gitBranches(ctx: Ctx, cfg: ProjectConfig, refresh = false): Promise<GitBranchInfo[]> {
  if (refresh || !gitCache.has(cfg.id)) gitCache.set(cfg.id, await git.listBranches(repoDir(cfg), cfg.repo.remote));
  return gitCache.get(cfg.id)!;
}

export function invalidateGitCache(projectId: string): void {
  gitCache.delete(projectId);
}

function indicator(live: BuildRow | undefined, latest: BuildRow | undefined, active: BuildRow | undefined): LiveIndicator {
  if (active) return 'building';
  if (latest?.status === 'failed') return 'failed';
  if (!live) return 'none';
  if (!runtimeState.docker.ok) return 'unknown';
  if (live.status === 'stopped') return 'stopped';
  if (live.tests && (live.tests.failed || live.tests.errors)) return 'failed';
  if (live.tests && live.tests.warnings) return 'warning';
  return 'ok';
}

export function branchView(ctx: Ctx, cfg: ProjectConfig, b: BranchRow, prodLive?: BuildRow | null): BranchView {
  const all = branchBuilds(ctx, b);
  const live = all.find((x) => x.live && (x.status === 'running' || x.status === 'stopped'));
  const latest = all.find((x) => x.status !== 'dropped');
  const active = all.find((x) => x.status === 'queued' || x.status === 'building');
  const r = resolveBranchScope(cfg, b.name, b.stage, b.overrides);
  const port = ctx.proxyPort ?? ctx.store.app.proxyPort;
  const hash = configHash(cfg, r.scope, port);
  const badges: BranchBadge[] = [];
  const head = r.scope.folder ? (b.lastSeenLocalSha ?? b.lastSeenRemoteSha) : b.lastSeenRemoteSha;
  // D59: read by the folder watcher; the actions themselves check the folder again.
  const folderBranch = r.scope.folder ? (localWatcher()?.folderBranch(b.id) ?? null) : null;
  const folderBlocked = !!folderBranch && folderBranch !== b.name;
  if (folderBlocked) {
    badges.push({
      kind: 'folder-wrong-branch',
      text: t('badge.folderWrongBranch', { folder: r.scope.folder, open: folderBranch, branch: b.name }),
    });
  }
  if (!live && !active) badges.push({ kind: 'no-build', text: t('badge.noBuild') });
  if (live && head && live.commitSha && head !== live.commitSha && !active && !folderBlocked) {
    badges.push({ kind: 'unbuilt-commits', text: t('badge.unbuilt') });
  }
  if (live && b.stageChangedAt && b.stageChangedAt > live.createdAt) {
    badges.push({ kind: 'stage-changed', text: t('badge.stageChanged') });
  }
  if (live && live.configHash && live.configHash !== hash) badges.push({ kind: 'config-changed', text: t('badge.configChanged') });
  // D64: the container mounts the worktree (same config), but it is on another commit — e.g. after building from the
  // user's folder. A changed config already asks for «Применить», which puts the worktree back itself.
  const wtHead = !r.scope.folder && live?.commitSha && b.worktreePath && !active && live.configHash === hash ? worktreeHeadSync(b.worktreePath) : null;
  if (wtHead && wtHead !== live!.commitSha) {
    badges.push({
      kind: 'worktree-off-build',
      text: t('badge.worktreeOffBuild', { head: wtHead.slice(0, 7), number: live!.number, sha: live!.commitSha!.slice(0, 7) }),
    });
  }
  if (b.pausedReason === 'dirty-worktree') badges.push({ kind: 'dirty-worktree', text: t('badge.dirtyWorktree') });
  if (b.pausedReason === 'force-push') badges.push({ kind: 'force-push', text: t('badge.forcePush') });
  // D47: a branch behind the code of its copy source gets the lag badge instead of «mirror newer» — a Rebuild from the
  // fresh copy would run older module code on that database.
  const lag = codeLagOf(ctx, cfg, b, r.scope);
  const behind = lag && lag.behind > 0 ? lag : null;
  if (behind) badges.push(lagBadge(behind));
  else if (live && live.sourceMirrorBuildId && prodLive && prodLive.id !== live.sourceMirrorBuildId && b.stage !== 'production') {
    badges.push({ kind: 'mirror-newer', text: t('badge.mirrorNewer') });
  }
  const liveView = live ? toBuildView(ctx, live, { branchName: b.name, currentHash: hash, dropAfterDays: r.scope.dropAfterDays, lastActiveAt: b.lastActiveAt }) : null;
  if (liveView && liveView.containerState === 'missing') badges.push({ kind: 'discrepancy', text: t('badge.noContainer') });
  return {
    id: b.id,
    projectId: b.projectId,
    name: b.name,
    slug: b.slug,
    stage: b.stage,
    assignedBy: b.assignedBy,
    folder: r.scope.folder,
    folderBranch,
    folderBlocked,
    worktreePath: b.worktreePath,
    codeDir: r.scope.folder ?? b.worktreePath,
    protected: r.scope.protected,
    odooVersion: r.scope.image === cfg.runtime.image ? cfg.runtime.odooVersion : `${cfg.runtime.odooVersion}*`,
    indicator: liveView?.containerState === 'missing' && !active ? 'failed' : indicator(live, latest, active),
    liveBuild: liveView,
    activeBuild: active ? toBuildView(ctx, active, { branchName: b.name }) : null,
    badges,
    codeLag: behind,
    url: live ? buildUrl(live.host, port) : null,
    lastActiveAt: b.lastActiveAt,
    hidden: b.hidden,
  };
}

export function productionLive(ctx: Ctx, cfg: ProjectConfig): BuildRow | null {
  const prod = branchByName(ctx, cfg.id, cfg.production.branch);
  return prod ? (liveBuild(ctx, prod.id) ?? null) : null;
}

export async function listBranches(ctx: Ctx, projectId: string): Promise<BranchesList> {
  const cfg = ctx.store.require(projectId);
  const rows = branchRows(ctx, projectId);
  const prodLive = productionLive(ctx, cfg);
  const views = rows.map((b) => branchView(ctx, cfg, b, prodLive));
  const byStage = (s: Stage) => views.filter((v) => v.stage === s).sort((a, b) => a.name.localeCompare(b.name));
  let known: GitBranchInfo[] = [];
  try {
    known = await gitBranches(ctx, cfg);
  } catch {
    known = [];
  }
  const added = new Set(rows.map((r) => r.name));
  const unassigned: UnassignedBranch[] = [];
  let ignored = 0;
  for (const g of known) {
    if (added.has(g.name)) continue;
    const sel = selectStage(cfg, g.name);
    if (sel.stage === 'ignore') {
      ignored++;
      continue;
    }
    unassigned.push({ name: g.name, source: g.source, suggestedStage: sel.stage, ruleIndex: sel.ruleIndex });
  }
  return { projectId, production: byStage('production'), development: byStage('development'), unassigned, ignoredCount: ignored, autoAdd: cfg.autoAddBranches };
}

export function getBranchView(ctx: Ctx, branchId: number): BranchView {
  const b = mustBranch(ctx, branchId);
  const cfg = ctx.store.require(b.projectId);
  return branchView(ctx, cfg, b, productionLive(ctx, cfg));
}

export function mustBranch(ctx: Ctx, branchId: number): BranchRow {
  const b = branchRow(ctx, branchId);
  if (!b) throw new BmError('NO_BRANCH', t('branches.notFound'));
  return b;
}

/** Adds an existing git branch to the project («+» или перетаскивание из «Не добавлены»). */
export async function addBranch(ctx: Ctx, p: { projectId: string; name: string; stage?: Stage; build?: boolean }): Promise<BranchView> {
  const cfg = ctx.store.require(p.projectId);
  const known = await gitBranches(ctx, cfg);
  if (!known.some((g) => g.name === p.name)) throw new BmError('NO_BRANCH_REF', t('branches.noRef', { name: p.name }));
  if (p.stage === 'production') throw new BmError('BAD_STAGE', t('branches.prodOne'));
  const sel = selectStage(cfg, p.name);
  const stage: Stage = p.stage ?? (sel.stage === 'ignore' || sel.stage === 'production' ? 'development' : sel.stage);
  setAutoAddSkip(ctx, cfg.id, p.name, false);
  const row = ensureBranchRow(ctx, cfg, p.name, stage, p.stage && p.stage !== sel.stage ? 'user' : 'rule');
  await recordHeads(ctx, cfg, row);
  audit(ctx, { projectId: cfg.id, action: 'branch.add', target: p.name, params: { stage } });
  bus.emit({ type: 'branch.changed', projectId: cfg.id, branchId: row.id });
  const scope = resolveBranchScope(cfg, row.name, row.stage, row.overrides).scope;
  if (p.build ?? scope.buildOnAdd) await requestBuildChecked(ctx, row.id, { trigger: 'manual' });
  return getBranchView(ctx, row.id);
}

/** What adding a branch to a stage will do: build right away or not, and where its database comes from. */
export function addPreview(ctx: Ctx, p: { projectId: string; name: string; stage: Stage }) {
  const cfg = ctx.store.require(p.projectId);
  const scope = resolveBranchScope(cfg, p.name, p.stage, null).scope;
  const database = scope.database === 'backup' ? 'fresh' : scope.database;
  const copyOf = !database.startsWith('copy:') ? null : database === 'copy:production' ? cfg.production.branch : database.slice('copy:'.length);
  return { build: scope.buildOnAdd, fresh: database === 'fresh', copyOf, withDemo: scope.withDemo };
}

/** Remembers the current remote head so only later commits count as "new" (the folder head is tracked by LocalWatcher). */
export async function recordHeads(ctx: Ctx, cfg: ProjectConfig, row: BranchRow): Promise<void> {
  const remoteSha = await git.remoteSha(repoDir(cfg), cfg.repo.remote, row.name);
  ctx.db
    .update(branches)
    .set({ lastSeenRemoteSha: remoteSha ?? row.lastSeenRemoteSha })
    .where(eq(branches.id, row.id))
    .run();
}

/**
 * Manual stage change (drag & drop). Fixes the stage (assignedBy=user). Moving a branch into Production rewrites
 * production.branch in the project file: the former production branch goes to Development (spec 6, D37).
 */
export function setStage(ctx: Ctx, branchId: number, stage: Stage): BranchView {
  const b = mustBranch(ctx, branchId);
  const cfg = ctx.store.require(b.projectId);
  if (b.stage === stage) return getBranchView(ctx, branchId);
  if (b.stage === 'production') {
    throw new BmError('BAD_STAGE', t('branches.prodEmpty'));
  }
  if (stage === 'production') {
    const e = ctx.store.get(cfg.id)!;
    const doc = YAML.parseDocument(e.text);
    doc.setIn(['production', 'branch'], b.name);
    const next = ctx.store.putProject(doc.toString(), { expectId: cfg.id });
    onProjectConfigChanged(ctx, cfg, next);
    audit(ctx, { projectId: cfg.id, action: 'branch.stage', target: b.name, params: { from: b.stage, to: stage, previousProduction: cfg.production.branch } });
    return getBranchView(ctx, branchId);
  }
  ctx.db.update(branches).set({ stage, assignedBy: 'user', stageChangedAt: nowIso() }).where(eq(branches.id, branchId)).run();
  audit(ctx, { projectId: cfg.id, action: 'branch.stage', target: b.name, params: { from: b.stage, to: stage } });
  bus.emit({ type: 'branch.changed', projectId: cfg.id, branchId });
  return getBranchView(ctx, branchId);
}

/** «Скрыть» / «Показать» in the sidebar. Only the list changes: builds, auto-builds and the branch itself stay. */
export function setHidden(ctx: Ctx, branchId: number, hidden: boolean): BranchView {
  const b = mustBranch(ctx, branchId);
  if (b.stage === 'production' && hidden) throw new BmError('BAD_STAGE', t('branches.hideProd'));
  if (b.hidden === hidden) return getBranchView(ctx, branchId);
  ctx.db.update(branches).set({ hidden }).where(eq(branches.id, branchId)).run();
  audit(ctx, { projectId: b.projectId, action: hidden ? 'branch.hide' : 'branch.show', target: b.name });
  bus.emit({ type: 'branch.changed', projectId: b.projectId, branchId });
  return getBranchView(ctx, branchId);
}

/** «Сбросить к правилу»: stage from branchRules again, rules may move it later. */
export function resetToRule(ctx: Ctx, branchId: number): BranchView {
  const b = mustBranch(ctx, branchId);
  const cfg = ctx.store.require(b.projectId);
  if (b.stage === 'production') return getBranchView(ctx, branchId);
  const sel = selectStage(cfg, b.name);
  const stage: Stage = sel.stage === 'ignore' || sel.stage === 'production' ? 'development' : sel.stage;
  ctx.db
    .update(branches)
    .set({ stage, assignedBy: 'rule', stageChangedAt: stage !== b.stage ? nowIso() : b.stageChangedAt })
    .where(eq(branches.id, branchId))
    .run();
  audit(ctx, { projectId: cfg.id, action: 'branch.resetToRule', target: b.name, params: { stage } });
  bus.emit({ type: 'branch.changed', projectId: cfg.id, branchId });
  return getBranchView(ctx, branchId);
}

/** Rule-assigned branches follow rule changes; user-fixed ones never move (spec 8.2). */
export function applyRules(ctx: Ctx, cfg: ProjectConfig): void {
  for (const b of branchRows(ctx, cfg.id)) {
    if (b.assignedBy !== 'rule' || b.stage === 'production') continue;
    const sel = selectStage(cfg, b.name);
    if (sel.stage === 'ignore' || sel.stage === 'production' || sel.stage === b.stage) continue;
    ctx.db.update(branches).set({ stage: sel.stage, stageChangedAt: nowIso() }).where(eq(branches.id, b.id)).run();
    bus.emit({ type: 'branch.changed', projectId: cfg.id, branchId: b.id });
  }
}

export function previewBranch(ctx: Ctx, projectId: string, name: string): UnassignedBranch {
  const cfg = ctx.store.require(projectId);
  const sel = selectStage(cfg, name);
  return { name, source: 'remote', suggestedStage: sel.stage, ruleIndex: sel.ruleIndex };
}

/** Name of a new branch from naming.branch.pattern (Fork / «Новая ветка»). */
export function forkName(ctx: Ctx, projectId: string, input: string): { name: string; base: string; valid: boolean; error: string | null } {
  const cfg = ctx.store.require(projectId);
  const nb = cfg.naming.branch;
  const prefix = nb.pattern.split('{name}')[0] ?? '';
  const short = prefix && input.startsWith(prefix) ? input.slice(prefix.length) : input;
  const valid = new RegExp(nb.nameRegex).test(short);
  let name = input;
  try {
    name = nb.pattern.includes('{name}') ? nb.pattern.replace('{name}', short) : renderTemplate(nb.pattern, { name: short });
  } catch {
    name = input;
  }
  return { name, base: nb.base, valid, error: valid ? null : t('branches.badName', { name: short, regex: nb.nameRegex }) };
}

/**
 * Fork (spec 8.10, D33): the new branch is created on the remote — `git push <remote> <sha>:refs/heads/<new>` from the
 * app's mirror (sha of the live build, else the head of the branch) → fetch → Development → build.
 * `interactive`: «Войти и повторить» after a failed push — Git Credential Manager may show its sign-in window (D57).
 */
export async function forkBranch(ctx: Ctx, p: { branchId: number; name: string; interactive?: boolean }): Promise<{ branch: BranchView; jobId: number | null }> {
  const src = mustBranch(ctx, p.branchId);
  const cfg = ctx.store.require(src.projectId);
  assertNotLegacy(cfg);
  const repo = repoDir(cfg);
  const n = forkName(ctx, cfg.id, p.name);
  if (!n.valid) throw new BmError('BAD_NAME', n.error!);
  if (!(await git.isValidBranchName(repo, n.name))) throw new BmError('BAD_NAME', t('branches.invalidGit', { name: n.name }));
  const known = await gitBranches(ctx, cfg, true);
  if (known.some((g) => g.name === n.name)) throw new BmError('BRANCH_EXISTS', t('branches.exists', { name: n.name }));
  const live = liveBuild(ctx, src.id);
  // A live build from the user's folder may sit on an unpushed commit: then the branch starts from the remote head.
  const liveSha = live?.commitSha && (await git.revParse(repo, live.commitSha)) ? live.commitSha : null;
  const start = liveSha ?? (await git.remoteSha(repo, cfg.repo.remote, src.name));
  if (!start) throw new BmError('NO_BRANCH_REF', t('branches.noCommit', { name: src.name }));
  await git.pushNewBranch(repo, cfg.repo.remote, start, n.name, { interactive: p.interactive });
  await git.fetch(repo, cfg.repo.remote);
  invalidateGitCache(cfg.id);
  const row = ensureBranchRow(ctx, cfg, n.name, 'development', 'user');
  await recordHeads(ctx, cfg, row);
  audit(ctx, { projectId: cfg.id, action: 'branch.fork', target: n.name, params: { from: src.name, sha: start, pushed: cfg.repo.remote } });
  bus.emit({ type: 'branch.changed', projectId: cfg.id, branchId: row.id });
  const jobId = await requestBuildChecked(ctx, row.id, { trigger: 'manual' });
  return { branch: getBranchView(ctx, row.id), jobId };
}
