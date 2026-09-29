import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import YAML from 'yaml';
import { BmError, type AgentSkillStatus, type ProjectConfig } from '@bm/shared';
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

/** Projects whose installed skill is older than what the app writes now (Status page). */
export function outdatedSkills(ctx: Ctx): { projectId: string; path: string }[] {
  const out: { projectId: string; path: string }[] = [];
  for (const e of ctx.store.list()) {
    if (!e.config?.agents.skillsDir) continue;
    try {
      const s = skillStatus(ctx, e.id);
      if (s.state === 'outdated') out.push({ projectId: e.id, path: s.path! });
    } catch {
      /* folder gone or unreadable: shown in the project settings */
    }
  }
  return out;
}

export async function installSkill(ctx: Ctx, projectId: string, dir: string, overwrite: boolean): Promise<{ path: string; inGit: boolean }> {
  const cfg = ctx.store.require(projectId);
  if (!path.isAbsolute(dir) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new BmError('BAD_DIR', `Папка «${dir}» не найдена. Выберите существующую папку, в которой открываете проект в Claude Code или Cursor.`);
  }
  const file = skillPath(dir, cfg.id);
  const next = content(ctx, cfg);
  const cur = stateOf(file, next);
  if ((cur.state === 'modified' || cur.state === 'foreign') && !overwrite) {
    throw new BmError('SKILL_MODIFIED', `${toPosix(file)} изменён вручную. Перезапишите его, если правки не нужны, или перенесите их в другой skill.`);
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
