import fs from 'node:fs';
import path from 'node:path';
import { eq, isNotNull } from 'drizzle-orm';
import { BmError, type ProjectConfig } from '@bm/shared';
import type { Ctx } from '../context';
import { branches, type BranchRow } from '../db/schema';
import * as git from './index';
import { assertOwned } from '../safety';
import { ownedRegistry } from '../registry';
import { samePath, toPosix } from '../util/paths';

export const worktreePathFor = (cfg: ProjectConfig, slug: string): string => toPosix(path.join(cfg.repo.worktreesDir, cfg.id, slug));

/**
 * Checks, before anything is created, that a `tracking: local` worktree is possible (criterion 12):
 * git allows a branch in one worktree only, so a branch checked out in the main checkout cannot get one.
 */
export async function assertLocalWorktreePossible(cfg: ProjectConfig, b: BranchRow): Promise<void> {
  const at = await git.branchCheckedOutAt(cfg.repo.path, b.name);
  if (!at) return;
  if (b.worktreePath && samePath(at, b.worktreePath)) return;
  if (samePath(at, cfg.repo.path)) {
    throw new BmError(
      'BRANCH_IN_MAIN_CHECKOUT',
      `Ветка «${b.name}» сейчас открыта в основном чекауте репозитория (${cfg.repo.path}). Git разрешает ветке только один worktree, ` +
        'поэтому режим tracking: local для неё невозможен. Переключите ветку на tracking: remote (сборка будет брать код из origin) ' +
        'или переключите основной чекаут на другую ветку.',
      { branchId: b.id, suggest: 'tracking-remote' },
    );
  }
  throw new BmError('BRANCH_IN_OTHER_WORKTREE', `Ветка «${b.name}» уже открыта в другом worktree: ${at}. Закройте его или используйте tracking: remote.`, {
    branchId: b.id,
    suggest: 'tracking-remote',
  });
}

/**
 * Creates (or reuses) the worktree of a branch (spec 8.2):
 * remote → `worktree add --detach <path> origin/<b>`; local → existing local branch, or `--track -b`.
 * Returns the worktree path. Idempotent.
 */
export async function ensureWorktree(ctx: Ctx, cfg: ProjectConfig, b: BranchRow, tracking: 'local' | 'remote'): Promise<string> {
  const repo = cfg.repo.path;
  const target = b.worktreePath ?? worktreePathFor(cfg, b.slug);
  const list = await git.worktreeList(repo);
  const existing = list.find((w) => samePath(w.path, target));

  if (existing && fs.existsSync(target)) {
    if (b.worktreeTracking === tracking || (tracking === 'remote' && existing.detached) || (tracking === 'local' && existing.branch === b.name)) {
      setWorktree(ctx, b.id, target, tracking);
      return target;
    }
    // Tracking mode changed: recreate only if nothing would be lost.
    const dirty = await git.statusPorcelain(target);
    if (dirty.trim()) {
      throw new BmError('WORKTREE_DIRTY', `В worktree ${target} есть незакоммиченные изменения, режим tracking изменить нельзя. Закоммитьте или отмените их:\n${dirty}`);
    }
    if (tracking === 'local') await assertLocalWorktreePossible(cfg, b);
    await removeWorktree(ctx, cfg, { ...b, worktreePath: target }, false);
  } else if (existing && !fs.existsSync(target)) {
    await git.worktreePrune(repo);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const remoteRef = (await git.remoteSha(repo, cfg.repo.remote, b.name)) ? `${cfg.repo.remote}/${b.name}` : null;
  const localRef = await git.localSha(repo, b.name);
  if (tracking === 'remote') {
    const ref = remoteRef ?? (localRef ? b.name : null);
    if (!ref) throw new BmError('NO_BRANCH_REF', `Ветка «${b.name}» не найдена ни в ${cfg.repo.remote}, ни локально. Выполните fetch.`);
    await git.worktreeAddDetached(repo, target, ref);
  } else {
    await assertLocalWorktreePossible(cfg, b);
    if (localRef) await git.worktreeAddBranch(repo, target, b.name);
    else if (remoteRef) await git.worktreeAddTrack(repo, target, b.name, cfg.repo.remote);
    else throw new BmError('NO_BRANCH_REF', `Ветка «${b.name}» не найдена ни в ${cfg.repo.remote}, ни локально. Выполните fetch.`);
  }
  setWorktree(ctx, b.id, target, tracking);
  return target;
}

function setWorktree(ctx: Ctx, branchId: number, p: string, tracking: 'local' | 'remote'): void {
  ctx.db.update(branches).set({ worktreePath: p, worktreeTracking: tracking }).where(eq(branches.id, branchId)).run();
}

/** Removes an app-owned worktree (never the main checkout). */
export async function removeWorktree(ctx: Ctx, cfg: ProjectConfig, b: BranchRow, force: boolean): Promise<void> {
  if (!b.worktreePath) return;
  assertOwned(cfg, { kind: 'worktree', path: b.worktreePath }, ownedRegistry(ctx, cfg.id));
  const list = await git.worktreeList(cfg.repo.path);
  if (list.some((w) => samePath(w.path, b.worktreePath!))) {
    await git.worktreeRemove(cfg.repo.path, b.worktreePath, force);
  } else if (fs.existsSync(b.worktreePath)) {
    fs.rmSync(b.worktreePath, { recursive: true, force: true });
  }
  await git.worktreePrune(cfg.repo.path);
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
