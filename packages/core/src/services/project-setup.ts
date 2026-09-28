import type { Ctx } from '../context';
import type { JobRow } from '../db/schema';
import { getQueue, type JobContext } from '../jobs/queue';
import { ensureManagedPostgres, pullImage } from '../docker/postgres';
import { runtimeState } from '../state';
import { log } from '../util/logger';

/** A new «Odoo in Docker» project prepares its runtime right away: Postgres container and the Odoo image (D30). */
export function requestSetup(ctx: Ctx, projectId: string): number | null {
  const cfg = ctx.store.require(projectId);
  if (cfg.postgres.mode !== 'managed') return null;
  return getQueue().enqueue('setup_project', { projectId });
}

/** Job `setup_project`: network, managed Postgres, `docker pull` of the Odoo image. */
export async function setupProjectExecutor(ctx: Ctx, job: JobRow, jc: JobContext): Promise<void> {
  const cfg = ctx.store.require(job.projectId!);
  await ensureManagedPostgres(ctx, cfg, jc.log);
  await pullImage(cfg.runtime.image, jc.log, jc.signal);
  jc.log(`проект ${cfg.id} готов к сборкам`);
}

/** Docker came up: start the managed Postgres of every enabled project (they also restart with Docker by themselves). */
export async function ensureAllManagedPostgres(ctx: Ctx): Promise<void> {
  if (!runtimeState.docker.ok) return;
  for (const e of ctx.store.list()) {
    const cfg = e.config;
    if (!cfg?.enabled || cfg.postgres.mode !== 'managed') continue;
    await ensureManagedPostgres(ctx, cfg).catch((err) => log().warn({ err, project: cfg.id }, 'managed postgres'));
  }
}
