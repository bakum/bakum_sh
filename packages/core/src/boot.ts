import type { Ctx } from './context';
import { JobQueue, setQueue } from './jobs/queue';
import { fetchExecutor, requestFetch, scheduleFetches, stopFetches } from './services/fetch';
import { LocalWatcher, setLocalWatcher } from './services/watch-local';
import { applyRules } from './services/branches';
import { deleteBranchExecutor } from './services/branch-delete';
import { deleteProjectExecutor } from './services/project-delete';
import { ensureTraefik } from './docker/traefik';
import { startDockerWatch, stopDockerWatch } from './docker/watch';
import { failInterruptedBuilds, reconcile } from './reconcile';
import { subscribeBuildLog, subscribeContainerLog, subscribeStats } from './services/logs';
import { publishTray } from './services/tray';
import { registerBuildExecutors } from './builds/executors';
import { runtime } from './runtime';
import { log } from './util/logger';

/** Wires background services: queue + executors, fetch scheduler, watchers, Traefik, reconciliation, hooks. */
export function bootServices(ctx: Ctx): { onConfigChanged: () => void } {
  const queue = new JobQueue(ctx);
  setQueue(queue);
  queue.register('fetch', fetchExecutor);
  queue.register('delete_branch', deleteBranchExecutor);
  queue.register('delete_project', deleteProjectExecutor);
  registerBuildExecutors(queue);

  const watcher = new LocalWatcher(ctx);
  setLocalWatcher(watcher);

  ctx.rpc.registerTopics({
    'build.log': (p, emit) => subscribeBuildLog(ctx, p.buildId, emit),
    'container.log': (p, emit) => subscribeContainerLog(ctx, p.buildId, emit),
    stats: (p, emit) => subscribeStats(ctx, p.buildId, emit),
  });

  runtime.onStart(async () => {
    const stale = queue.interruptStale();
    if (stale.length) log().warn({ count: stale.length }, 'interrupted stale jobs');
    failInterruptedBuilds(ctx, stale);
    scheduleFetches(ctx);
    watcher.start();
    publishTray(ctx);
    // First fetch right after start (criterion 3: the sidebar matches odoo.sh after the first fetch).
    requestFetch(ctx);
  });
  runtime.onDockerUp(async () => {
    startDockerWatch(ctx);
    await ensureTraefik(ctx);
    await reconcile(ctx);
  });
  runtime.onStop(async (_c, cancel) => {
    stopFetches();
    stopDockerWatch();
    watcher.stop();
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
      for (const e of ctx.store.list()) if (e.config) applyRules(ctx, e.config);
      void ensureTraefik(ctx);
    },
  };
}
