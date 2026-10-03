import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import YAML from 'yaml';
import { BmError, type AgentSkillStatus, type OutdatedSkill, type ProjectConfig } from '@bm/shared';
import type { Ctx } from '../context';
import { branches } from '../db/schema';
import { resolveBranchScope } from '../config/effective';
import { branchProtected } from '../docker/compose';
import { parseSkill, skillFile, skillName } from '../agents/skill';
import { cliCommandPaths } from '../cli/commands';
import * as git from '../git';
import { isInside, samePath, toPosix } from '../util/paths';
import { audit } from './audit';
import { onProjectConfigChanged } from './projects';
import { notify } from './notify';
import { log } from '../util/logger';
import { t } from '../i18n';

/** Protected branches of the project now: the settings list plus branches of the registry with the protected setting. */
function protectedBranches(ctx: Ctx, cfg: ProjectConfig): string[] {
  const rows = ctx.db.select().from(branches).where(eq(branches.projectId, cfg.id)).all();
  const fromRows = rows.filter((b) => branchProtected(cfg, b.name, b.stage, resolveBranchScope(cfg, b.name, b.stage, b.overrides).scope)).map((b) => b.name);
  return [...new Set([...cfg.repo.protectedBranches, ...fromRows])].sort();
}

function content(ctx: Ctx, cfg: ProjectConfig): string {
  return skillFile({
    cfg,
    appVersion: ctx.appVersion,
    proxyPort: ctx.proxyPort ?? ctx.store.app.proxyPort,
    logsDir: toPosix(ctx.logsDir),
    configDir: toPosix(ctx.configDir),
    protectedBranches: protectedBranches(ctx, cfg),
    appRepository: ctx.store.app.updates.repository,
    cli: ctx.cli ? cliCommandPaths(ctx.cli.binDir) : null,
    windows: process.platform === 'win32',
  });
}

/**
 * Folders offered for the skill: the root of the user's stack (the parent of `<root>/worktrees`, where the assistant
 * is usually opened) and the user's own clone. Only existing folders; the app's own data folder (the default
 * worktrees of projects without a stack of their own) is never offered.
 */
function suggestedDirs(ctx: Ctx, cfg: ProjectConfig): string[] {
  const out: string[] = [];
  const wt = cfg.repo.worktreesDir.replace(/[\\/]+$/, '');
  const root = path.dirname(wt);
  if (path.basename(wt).toLowerCase() === 'worktrees' && !samePath(root, ctx.dataDir) && !isInside(ctx.dataDir, root)) out.push(toPosix(root));
  if (cfg.repo.localFolder) out.push(toPosix(cfg.repo.localFolder));
  return [...new Set(out)].filter((d) => fs.existsSync(d));
}

const skillPath = (dir: string, projectId: string): string => path.join(dir, '.claude', 'skills', skillName(projectId), 'SKILL.md');

function stateOf(file: string | null, next: string): Pick<AgentSkillStatus, 'state' | 'installedVersion'> {
  if (!file || !fs.existsSync(file)) return { state: 'none', installedVersion: null };
  const text = fs.readFileSync(file, 'utf8');
  const m = parseSkill(text);
  if (!m) return { state: 'foreign', installedVersion: null };
  if (m.modified) return { state: 'modified', installedVersion: m.version };
  return { state: m.hash === parseSkill(next)!.hash ? 'current' : 'outdated', installedVersion: m.version };
}

export function skillStatus(ctx: Ctx, projectId: string, dirOverride?: string): AgentSkillStatus {
  const cfg = ctx.store.require(projectId);
  const suggested = suggestedDirs(ctx, cfg);
  const dir = dirOverride ?? cfg.agents.skillsDir ?? suggested[0] ?? null;
  const file = dir ? skillPath(dir, cfg.id) : null;
  const next = content(ctx, cfg);
  return {
    name: skillName(cfg.id),
    dir: dir ? toPosix(dir) : null,
    suggestedDirs: suggested,
    path: file ? toPosix(file) : null,
    ...stateOf(file, next),
    currentVersion: ctx.appVersion,
    content: next,
  };
}

/**
 * Projects whose installed skill is behind what the app writes now (the warning under the header, Status page; D75).
 * A skill edited by hand counts when the app's own text changed since it was written (the marker keeps that hash).
 */
export function outdatedSkills(ctx: Ctx): OutdatedSkill[] {
  const out: OutdatedSkill[] = [];
  for (const e of ctx.store.list()) {
    const cfg = e.config;
    if (!cfg?.agents.skillsDir) continue;
    try {
      const file = skillPath(cfg.agents.skillsDir, cfg.id);
      if (!fs.existsSync(file)) continue;
      const m = parseSkill(fs.readFileSync(file, 'utf8'));
      if (!m || m.hash === parseSkill(content(ctx, cfg))!.hash) continue;
      out.push({
        projectId: cfg.id,
        projectName: cfg.name,
        path: toPosix(file),
        dir: cfg.agents.skillsDir,
        installedVersion: m.version,
        currentVersion: ctx.appVersion,
        modified: m.modified,
      });
    } catch {
      /* folder gone or unreadable: shown in the project settings */
    }
  }
  return out;
}

/**
 * Desktop notification about skills that fell behind (D75): once per project and app version, checked after start
 * and after settings changes. The skill itself is never rewritten without the user.
 */
export function warnOutdatedSkills(ctx: Ctx): void {
  for (const s of outdatedSkills(ctx)) {
    const key = `skill-warned:${s.projectId}`;
    const seen = (ctx.sqlite.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)?.value;
    const stamp = `${ctx.appVersion}|${parseSkill(content(ctx, ctx.store.require(s.projectId)))!.hash}`;
    if (seen === stamp) continue;
    ctx.sqlite.prepare('INSERT OR REPLACE INTO kv(key, value) VALUES (?, ?)').run(key, stamp);
    log().info({ projectId: s.projectId, installed: s.installedVersion, modified: s.modified }, 'assistant skill outdated: warned');
    notify(ctx, 'skillOutdated', t('agents.outdatedTitle', { name: s.projectName }), t(s.modified ? 'agents.outdatedModifiedBody' : 'agents.outdatedBody'), {
      route: `/projects/${s.projectId}/settings/agents`,
    });
  }
}

let checkTimer: NodeJS.Timeout | null = null;
let hourly: NodeJS.Timeout | null = null;

/** Checks the skills after `delayMs` (a later call replaces an earlier one: settings edits come in bursts). */
export function scheduleSkillCheck(ctx: Ctx, delayMs = 5000): void {
  if (checkTimer) clearTimeout(checkTimer);
  checkTimer = setTimeout(() => {
    checkTimer = null;
    try {
      warnOutdatedSkills(ctx);
    } catch (err) {
      log().warn({ err }, 'skill check failed');
    }
  }, delayMs);
}

/** After start (the app may have just been updated), then hourly: protected branches also change the text. */
export function startSkillChecks(ctx: Ctx): void {
  stopSkillChecks();
  scheduleSkillCheck(ctx, 10_000);
  hourly = setInterval(() => scheduleSkillCheck(ctx, 0), 3_600_000);
}

export function stopSkillChecks(): void {
  if (checkTimer) clearTimeout(checkTimer);
  if (hourly) clearInterval(hourly);
  checkTimer = null;
  hourly = null;
}

export async function installSkill(ctx: Ctx, projectId: string, dir: string, overwrite: boolean): Promise<{ path: string; inGit: boolean }> {
  const cfg = ctx.store.require(projectId);
  if (!path.isAbsolute(dir) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new BmError('BAD_DIR', t('agents.badDir', { dir }));
  }
  const file = skillPath(dir, cfg.id);
  const next = content(ctx, cfg);
  const cur = stateOf(file, next);
  if ((cur.state === 'modified' || cur.state === 'foreign') && !overwrite) {
    throw new BmError('SKILL_MODIFIED', t('agents.modified', { file: toPosix(file) }));
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, next, 'utf8');
  fs.renameSync(tmp, file);

  if (toPosix(dir) !== cfg.agents.skillsDir) {
    const e = ctx.store.get(projectId)!;
    const doc = YAML.parseDocument(e.text);
    doc.setIn(['agents', 'skillsDir'], toPosix(dir));
    const saved = ctx.store.putProject(doc.toString(), { expectId: projectId });
    onProjectConfigChanged(ctx, cfg, saved);
  }
  audit(ctx, { projectId, action: 'agents.skill', target: toPosix(file), params: { version: ctx.appVersion, previous: cur.state } });
  // The next time the skill falls behind is a new warning, even with a text seen before.
  ctx.sqlite.prepare('DELETE FROM kv WHERE key = ?').run(`skill-warned:${projectId}`);

  let inGit = false;
  try {
    const top = await git.topLevel(dir);
    inGit = !!top && !(await git.isIgnored(top, toPosix(path.relative(top, file))));
  } catch {
    /* no git: nothing to warn about */
  }
  return { path: toPosix(file), inGit };
}

export function registerAgentHandlers(ctx: Ctx): void {
  ctx.rpc.register({
    'agents.skillStatus': (p) => skillStatus(ctx, p.projectId, p.dir),
    'agents.installSkill': (p) => installSkill(ctx, p.projectId, p.dir, p.overwrite),
  });
}
