import type { Ctx } from './context';
import { JobQueue, setQueue } from './jobs/queue';
import { fetchExecutor, requestFetch, scheduleFetches, stopFetches } from './services/fetch';
import { LocalWatcher, setLocalWatcher } from './services/watch-local';
import { applyRules } from './services/branches';
import { runtime } from './runtime';
import { deleteBranchExecutor } from './services/branch-delete';
import { log } from './util/logger';

/** Wires background services: queue + executors, fetch scheduler, local HEAD watcher, hooks. */
export function bootServices(ctx: Ctx): { onConfigChanged: () => void } {
  const queue = new JobQueue(ctx);
  setQueue(queue);
  queue.register('fetch', fetchExecutor);
  queue.register('delete_branch', deleteBranchExecutor);

  const watcher = new LocalWatcher(ctx);
  setLocalWatcher(watcher);

  runtime.onStart(async () => {
    const stale = queue.interruptStale();
    if (stale.length) log().warn({ count: stale.length }, 'interrupted stale jobs');
    scheduleFetches(ctx);
    watcher.start();
    // First fetch right after start (spec criterion 3: the sidebar matches odoo.sh after the first fetch).
    requestFetch(ctx);
  });
  runtime.onStop(async (_c, cancel) => {
    stopFetches();
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
    },
  };
}
