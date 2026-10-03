import type { Ctx } from './context';
import { JobQueue, setQueue } from './jobs/queue';
import { fetchExecutor, requestFetch, scheduleFetches, stopFetches } from './services/fetch';
import { LocalWatcher, setLocalWatcher } from './services/watch-local';
import { BackupWatcher } from './services/backup-watch';
import { ActivityCollector, setActivityCollector } from './services/activity';
import { startMonitor, stopMonitor } from './services/monitor';
import { startLifecycle, stopLifecycle } from './services/lifecycle';
import { scheduleSkillCheck, startSkillChecks, stopSkillChecks } from './services/agents';
import { applyRules } from './services/branches';
import { deleteBranchExecutor } from './services/branch-delete';
import { deleteProjectExecutor } from './services/project-delete';
import { cloneExecutor } from './services/repo';
import { buildImageExecutor, ensureAllManagedPostgres, setupProjectExecutor } from './services/project-setup';
import { pgMigrateExecutor } from './services/pg-migrate';
import { ensureTraefik } from './docker/traefik';
import { forgetContainers, startDockerWatch, stopDockerWatch } from './docker/watch';
import { failInterruptedBuilds, reconcile } from './reconcile';
import { subscribeBuildLog, subscribeContainerLog, subscribeStats } from './services/logs';
import { publishTray } from './services/tray';
import { bus } from './events';
import { registerBuildExecutors } from './builds/executors';
import { backfillCommitEmails } from './builds/commit-emails';
import { registerSnapshotExecutors } from './services/snapshots';
import { runtime } from './runtime';
import { log } from './util/logger';

/** Wires background services: queue + executors, fetch scheduler, watchers, Traefik, reconciliation, hooks. */
export function bootServices(ctx: Ctx): { onConfigChanged: () => void } {
  const queue = new JobQueue(ctx);
  setQueue(queue);
  queue.register('fetch', fetchExecutor);
  queue.register('delete_branch', deleteBranchExecutor);
  queue.register('delete_project', deleteProjectExecutor);
  queue.register('clone', cloneExecutor);
  queue.register('setup_project', setupProjectExecutor);
  queue.register('build_image', buildImageExecutor);
  queue.register('migrate_postgres', pgMigrateExecutor);
  registerBuildExecutors(queue);
  registerSnapshotExecutors(queue);

  // Tray «building» follows the queue: re-published after a job starts or finishes (a build publishing the tray
  // itself still sees its own job as running).
  bus.on((batch) => {
    if (batch.some((e) => e.type === 'job.changed')) publishTray(ctx);
  });

  const watcher = new LocalWatcher(ctx);
  setLocalWatcher(watcher);
  const backups = new BackupWatcher(ctx);
  const activity = new ActivityCollector(ctx);
  setActivityCollector(activity);

  ctx.rpc.registerTopics({
    'build.log': (p, emit) => subscribeBuildLog(ctx, p.buildId, p.file, emit),
    'container.log': (p, emit) => subscribeContainerLog(ctx, p.buildId, emit),
    stats: (p, emit) => subscribeStats(ctx, p.buildId, emit),
  });

  runtime.onStart(async () => {
    const stale = queue.interruptStale();
    if (stale.length) log().warn({ count: stale.length }, 'interrupted stale jobs');
    failInterruptedBuilds(ctx, stale);
    scheduleFetches(ctx);
    watcher.start();
    backups.sync();
    startMonitor(ctx);
    startLifecycle(ctx);
    startSkillChecks(ctx);
    publishTray(ctx);
    // First fetch right after start (criterion 3: the sidebar matches odoo.sh after the first fetch).
    requestFetch(ctx);
    // Avatars in History for builds recorded before D65.
    void backfillCommitEmails(ctx).catch((err) => log().warn({ err }, 'commit emails backfill failed'));
  });
  runtime.onDockerUp(async () => {
    startDockerWatch(ctx);
    await ensureTraefik(ctx);
    activity.start();
    await ensureAllManagedPostgres(ctx);
    await reconcile(ctx);
    // Jobs that waited for Docker (D63).
    void queue.pump();
  });
  runtime.onDockerDown(() => forgetContainers());
  runtime.onStop(async (_c, cancel) => {
    stopFetches();
    stopDockerWatch();
    watcher.stop();
    backups.stop();
    activity.stop();
    stopMonitor();
    stopLifecycle();
    stopSkillChecks();
    if (cancel) queue.cancelAll();
    else await queue.drain(3000);
    queue.stop();
  });
  runtime.onHook('fetch', async (c, args) => {
    requestFetch(c, args[0]);
  });

  return {
    onConfigChanged: () => {
      scheduleFetches(ctx);
      backups.sync();
      for (const e of ctx.store.list()) if (e.config) applyRules(ctx, e.config);
      void ensureTraefik(ctx);
      scheduleSkillCheck(ctx);
    },
  };
}
