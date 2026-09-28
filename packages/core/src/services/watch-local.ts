import fs from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { eq, isNotNull } from 'drizzle-orm';
import type { Ctx } from '../context';
import { branches, type BranchRow } from '../db/schema';
import * as git from '../git';
import { resolveBranchScope } from '../config/effective';
import { onNewCommit } from '../builds/triggers';
import { bus } from '../events';
import { log } from '../util/logger';

/**
 * `tracking: local` triggers (spec 8.3): HEAD of the branch worktree is watched with chokidar
 * (`.git/worktrees/<name>/HEAD` and `refs/heads/<branch>`) plus a 30 s poll as a safety net.
 */
export class LocalWatcher {
  private watchers = new Map<number, FSWatcher>();
  private timer: NodeJS.Timeout | null = null;
  private checking = new Set<number>();

  constructor(private readonly ctx: Ctx) {}

  start(): void {
    void this.sync();
    this.timer = setInterval(() => void this.pollAll(), 30_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const w of this.watchers.values()) void w.close();
    this.watchers.clear();
  }

  private localBranches(): BranchRow[] {
    return this.ctx.db
      .select()
      .from(branches)
      .where(isNotNull(branches.worktreePath))
      .all()
      .filter((b) => b.worktreeTracking === 'local');
  }

  /** Re-reads which worktrees to watch (after builds, stage or settings changes). */
  async sync(): Promise<void> {
    const rows = this.localBranches();
    const ids = new Set(rows.map((r) => r.id));
    for (const [id, w] of this.watchers) {
      if (!ids.has(id)) {
        void w.close();
        this.watchers.delete(id);
      }
    }
    for (const b of rows) {
      if (this.watchers.has(b.id) || !b.worktreePath || !fs.existsSync(b.worktreePath)) continue;
      const gitDir = await git.gitDir(b.worktreePath).catch(() => null);
      const common = await git.commonDir(b.worktreePath).catch(() => null);
      if (!gitDir) continue;
      const files = [path.join(gitDir, 'HEAD')];
      if (common) files.push(path.join(common, 'refs', 'heads', ...b.name.split('/')));
      const w = chokidar.watch(files, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 300 } });
      w.on('all', () => void this.check(b.id));
      this.watchers.set(b.id, w);
    }
  }

  private async pollAll(): Promise<void> {
    for (const b of this.localBranches()) await this.check(b.id);
  }

  async check(branchId: number): Promise<void> {
    if (this.checking.has(branchId)) return;
    this.checking.add(branchId);
    try {
      const b = this.ctx.db.select().from(branches).where(eq(branches.id, branchId)).get();
      if (!b?.worktreePath || b.worktreeTracking !== 'local') return;
      const e = this.ctx.store.get(b.projectId);
      if (!e?.config) return;
      const scope = resolveBranchScope(e.config, b.name, b.stage, b.overrides).scope;
      if (scope.tracking !== 'local') return;
      const sha = await git.headSha(b.worktreePath);
      if (!sha || sha === b.lastSeenLocalSha) return;
      this.ctx.db.update(branches).set({ lastSeenLocalSha: sha }).where(eq(branches.id, b.id)).run();
      log().info({ branch: b.name, sha }, 'local commit detected');
      bus.emit({ type: 'branch.changed', projectId: b.projectId, branchId: b.id });
      await onNewCommit(this.ctx, e.config, { ...b, lastSeenLocalSha: sha }, sha, { forcePush: false });
    } catch (err) {
      log().warn({ err, branchId }, 'local HEAD check failed');
    } finally {
      this.checking.delete(branchId);
    }
  }
}

let watcher: LocalWatcher | null = null;
export const setLocalWatcher = (w: LocalWatcher): void => {
  watcher = w;
};
export const localWatcher = (): LocalWatcher | null => watcher;
