import fs from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { eq } from 'drizzle-orm';
import { isLegacyProject } from '@bm/shared';
import type { Ctx } from '../context';
import { branches, type BranchRow } from '../db/schema';
import * as git from '../git';
import { resolveBranchScope } from '../config/effective';
import { onNewCommit } from '../builds/triggers';
import { bus } from '../events';
import { log } from '../util/logger';

/**
 * Triggers of branches built from the user's folder (spec 8.3, D33): HEAD of the folder is watched with chokidar
 * (`.git/HEAD` and the refs of the checked-out branch) plus a 30 s poll as a safety net. Read-only.
 */
export class LocalWatcher {
  private watchers = new Map<number, { watcher: FSWatcher; folder: string }>();
  private timer: NodeJS.Timeout | null = null;
  private checking = new Set<number>();

  constructor(private readonly ctx: Ctx) {}

  start(): void {
    void this.sync();
    this.timer = setInterval(() => void this.pollAll(), 30_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const w of this.watchers.values()) void w.watcher.close();
    this.watchers.clear();
  }

  /** Branches whose code comes from the user's folder, with that folder. */
  private folderBranches(): { b: BranchRow; folder: string }[] {
    const out: { b: BranchRow; folder: string }[] = [];
    for (const b of this.ctx.db.select().from(branches).all()) {
      const cfg = this.ctx.store.get(b.projectId)?.config;
      if (!cfg || isLegacyProject(cfg)) continue;
      const folder = resolveBranchScope(cfg, b.name, b.stage, b.overrides).scope.folder;
      if (folder) out.push({ b, folder });
    }
    return out;
  }

  /** Re-reads which worktrees to watch (after builds, stage or settings changes). */
  async sync(): Promise<void> {
    const rows = this.folderBranches();
    const want = new Map(rows.map((r) => [r.b.id, r.folder]));
    for (const [id, w] of this.watchers) {
      if (want.get(id) !== w.folder) {
        void w.watcher.close();
        this.watchers.delete(id);
      }
    }
    for (const { b, folder } of rows) {
      if (this.watchers.has(b.id) || !fs.existsSync(folder)) continue;
      const gitDir = await git.gitDir(folder).catch(() => null);
      const common = await git.commonDir(folder).catch(() => null);
      if (!gitDir) continue;
      // Any branch of the folder may be checked out: watch HEAD and all local branch refs.
      const files = [path.join(gitDir, 'HEAD'), ...(common ? [path.join(common, 'refs', 'heads'), path.join(common, 'packed-refs')] : [])];
      // The folder was just chosen (or the app started): its HEAD now is the starting point, so the next commit counts.
      if (!b.lastSeenLocalSha) {
        const head = await git.headSha(folder).catch(() => null);
        if (head) this.ctx.db.update(branches).set({ lastSeenLocalSha: head }).where(eq(branches.id, b.id)).run();
      }
      const w = chokidar.watch(files, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 300 } });
      w.on('all', () => void this.check(b.id));
      this.watchers.set(b.id, { watcher: w, folder });
    }
  }

  private async pollAll(): Promise<void> {
    for (const { b } of this.folderBranches()) await this.check(b.id);
  }

  async check(branchId: number): Promise<void> {
    if (this.checking.has(branchId)) return;
    this.checking.add(branchId);
    try {
      const b = this.ctx.db.select().from(branches).where(eq(branches.id, branchId)).get();
      if (!b) return;
      const e = this.ctx.store.get(b.projectId);
      if (!e?.config || isLegacyProject(e.config)) return;
      const scope = resolveBranchScope(e.config, b.name, b.stage, b.overrides).scope;
      if (!scope.folder || !fs.existsSync(scope.folder)) return;
      const sha = await git.headSha(scope.folder);
      if (!sha || sha === b.lastSeenLocalSha) return;
      this.ctx.db.update(branches).set({ lastSeenLocalSha: sha }).where(eq(branches.id, b.id)).run();
      // The folder was just chosen: its current HEAD is the starting point, not a new commit.
      if (!b.lastSeenLocalSha) return;
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
