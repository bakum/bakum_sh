import fs from 'node:fs';
import path from 'node:path';
import { eq, isNotNull } from 'drizzle-orm';
import { BmError, type ProjectConfig, type ResolvedBranchScope } from '@bm/shared';
import type { Ctx } from '../context';
import { branches, type BranchRow } from '../db/schema';
import * as git from './index';
import { assertOwned } from '../safety';
import { ownedRegistry } from '../registry';
import { resolveBranchScope } from '../config/effective';
import { samePath, toPosix } from '../util/paths';

/** A branch of the project is gone from the mirror: fetch prunes branches deleted on the remote (D49). */
export const noRemoteBranch = (name: string, remote: string): string =>
  `Ветки «${name}» нет в ${remote}: её удалили или переименовали на GitHub. Если ветка только что создана, нажмите ` +
  '«Обновить» (fetch); иначе удалите её в приложении.';

export const worktreePathFor =(cfg: ProjectConfig, slug: string): string => toPosix(path.join(cfg.repo.worktreesDir, cfg.id, slug));

/**
 * Git repository the app works in (D33): its own mirror; for a legacy project — the user's repository, used only to
 * remove the worktrees the app once created there.
 */
export function repoDir(cfg: ProjectConfig): string {
  const dir = cfg.repo.mirrorDir ?? cfg.repo.path;
  if (!dir) throw new BmError('CONFIG_INVALID', `У проекта «${cfg.id}» не задан repo.mirrorDir`);
  return dir;
}

/**
 * Where the code of a branch comes from (D33):
 * - `mirror` — a detached worktree of the app's mirror (`dir` is null until it is created), git reads go to the mirror;
 * - `folder` — the user's own clone (Development branch setting): mounted as is, only read by the app.
 */
export type CodeSource = { kind: 'mirror'; repo: string; dir: string | null } | { kind: 'folder'; repo: string; dir: string };

export function codeSource(cfg: ProjectConfig, b: Pick<BranchRow, 'worktreePath'>, scope: Pick<ResolvedBranchScope, 'folder'>): CodeSource {
  if (scope.folder) {
    const dir = toPosix(path.resolve(scope.folder));
    return { kind: 'folder', repo: dir, dir };
  }
  return { kind: 'mirror', repo: repoDir(cfg), dir: b.worktreePath };
}

/** The user's folder must be the root of a git clone: it is mounted where the repository root is expected. */
export async function assertFolderUsable(folder: string): Promise<void> {
  if (!fs.existsSync(folder)) throw new BmError('NO_DIR', `Папка «${folder}» не найдена.`);
  const top = await git.topLevel(folder);
  if (!top) throw new BmError('NOT_A_REPO', `Папка «${folder}» не является git-репозиторием.`);
  if (!samePath(top, folder)) throw new BmError('NOT_REPO_ROOT', `Укажите корень репозитория: ${top}`);
}

/** The only job that runs while another branch is open in the folder (D59): it neither reads the code nor loses data. */
export const FOLDER_SAFE_JOBS: ReadonlySet<string> = new Set(['stop']);

/** Shown instead of a branch name when HEAD of the folder is detached (rebase, checkout of a commit). */
export const DETACHED = '(detached)';

/** Branch open in the user's folder when it is not `branchName` (DETACHED for a detached HEAD); null — it matches. */
export async function folderBranchMismatch(folder: string, branchName: string): Promise<string | null> {
  const current = (await git.currentBranch(folder)) ?? DETACHED;
  return current === branchName ? null : current;
}

export const folderWrongBranchText = (folder: string, open: string, branchName: string): string =>
  `В папке ${folder} открыта ветка ${open}, а сборка — ветки ${branchName}. Сборка заблокирована, с ней ничего не ` +
  `происходит. Откройте в папке ${branchName} (git checkout ${branchName}) или выберите источник кода «С GitHub» ` +
  '(вкладка Editor). Работает только Stop.';

/**
 * Why a build from the user's folder is blocked (D59), null — it is not: another branch is open in the folder. A folder
 * that is gone or is not a repository does not block by itself (actions that read the code check it separately).
 */
export async function folderBlock(b: Pick<BranchRow, 'name'>, scope: Pick<ResolvedBranchScope, 'folder'>): Promise<string | null> {
  if (!scope.folder) return null;
  const dir = toPosix(path.resolve(scope.folder));
  if (!fs.existsSync(dir) || !(await git.topLevel(dir))) return null;
  const open = await folderBranchMismatch(dir, b.name);
  return open ? folderWrongBranchText(dir, open, b.name) : null;
}

/**
 * A build from the user's folder is blocked while another branch is open there (D59): the IDE switched branches, and
 * building, restarting or updating modules would run that branch's code on this branch's database; dropping it is
 * refused too. `usable` (actions that read the code) also requires the folder to be the root of a clone.
 */
export async function assertFolderOnBranch(b: Pick<BranchRow, 'name'>, scope: Pick<ResolvedBranchScope, 'folder'>, opts: { usable?: boolean } = {}): Promise<void> {
  if (!scope.folder) return;
  if (opts.usable ?? true) await assertFolderUsable(toPosix(path.resolve(scope.folder)));
  const why = await folderBlock(b, scope);
  if (why) throw new BmError('FOLDER_WRONG_BRANCH', why);
}

/** assertFolderOnBranch by branch id, for jobs and actions on a build (start, restart, modules, tests, drop…). */
export async function assertBranchFolder(ctx: Ctx, branchId: number, opts: { usable?: boolean } = {}): Promise<void> {
  const b = ctx.db.select().from(branches).where(eq(branches.id, branchId)).get();
  const cfg = b ? ctx.store.get(b.projectId)?.config : null;
  if (!b || !cfg) return;
  await assertFolderOnBranch(b, resolveBranchScope(cfg, b.name, b.stage, b.overrides).scope, opts);
}

/**
 * Creates (or reuses) the detached worktree of a branch in the app's mirror (spec 8.2, D33):
 * `worktree add --detach <path> <remote>/<b>`. No local branches, so git never locks a branch. Returns the path.
 */
export async function ensureWorktree(ctx: Ctx, cfg: ProjectConfig, b: BranchRow): Promise<string> {
  const repo = repoDir(cfg);
  const target = b.worktreePath ?? worktreePathFor(cfg, b.slug);
  const list = await git.worktreeList(repo);
  const existing = list.find((w) => samePath(w.path, target));

  if (existing && fs.existsSync(target)) {
    setWorktree(ctx, b.id, target);
    return target;
  }
  if (existing) await git.worktreePrune(repo);

  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!(await git.remoteSha(repo, cfg.repo.remote, b.name))) throw new BmError('NO_BRANCH_REF', noRemoteBranch(b.name, cfg.repo.remote));
  await git.worktreeAddDetached(repo, target, `${cfg.repo.remote}/${b.name}`);
  setWorktree(ctx, b.id, target);
  return target;
}

function setWorktree(ctx: Ctx, branchId: number, p: string): void {
  ctx.db.update(branches).set({ worktreePath: p, worktreeTracking: 'remote' }).where(eq(branches.id, branchId)).run();
}

/** Removes an app-owned worktree (never the mirror itself or the user's folder). */
export async function removeWorktree(ctx: Ctx, cfg: ProjectConfig, b: BranchRow, force: boolean): Promise<void> {
  if (!b.worktreePath) return;
  assertOwned(cfg, { kind: 'worktree', path: b.worktreePath }, ownedRegistry(ctx, cfg.id));
  const repo = repoDir(cfg);
  const list = fs.existsSync(repo) ? await git.worktreeList(repo) : [];
  if (list.some((w) => samePath(w.path, b.worktreePath!))) {
    await git.worktreeRemove(repo, b.worktreePath, force);
  } else if (fs.existsSync(b.worktreePath)) {
    fs.rmSync(b.worktreePath, { recursive: true, force: true });
  }
  if (fs.existsSync(repo)) await git.worktreePrune(repo);
  ctx.db.update(branches).set({ worktreePath: null, worktreeTracking: null }).where(eq(branches.id, b.id)).run();
}

export function registeredWorktrees(ctx: Ctx, projectId: string): string[] {
  return ctx.db
    .select({ p: branches.worktreePath, pid: branches.projectId })
    .from(branches)
    .where(isNotNull(branches.worktreePath))
    .all()
    .filter((r) => r.pid === projectId)
    .map((r) => r.p!);
}
