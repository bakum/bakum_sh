import { BmError } from '@bm/shared';
import type { Ctx } from '../context';
import type { JobRow } from '../db/schema';
import { getQueue, type JobContext } from '../jobs/queue';
import { ensureManagedPostgres } from '../docker/postgres';
import { buildImage, ensureImage } from '../docker/image';
import { audit } from './audit';
import { runtimeState } from '../state';
import { log } from '../util/logger';
import { t } from '../i18n';

/** A new «Odoo in Docker» project prepares its runtime right away: Postgres container and the Odoo image (D30). */
export function requestSetup(ctx: Ctx, projectId: string): number | null {
  const cfg = ctx.store.require(projectId);
  if (cfg.postgres.mode !== 'managed') return null;
  return getQueue().enqueue('setup_project', { projectId });
}

/** Job `setup_project`: network, managed Postgres, the Odoo image (`docker pull`, or `docker build` with runtime.build). */
export async function setupProjectExecutor(ctx: Ctx, job: JobRow, jc: JobContext): Promise<void> {
  const cfg = ctx.store.require(job.projectId!);
  await ensureManagedPostgres(ctx, cfg, jc.log);
  await ensureImage(cfg, cfg.runtime.image, jc.log, jc.signal);
  jc.log(t('setup.ready', { id: cfg.id }));
}

/** «Собрать образ» (Settings → Рантайм): `docker build` of runtime.build now, to check the Dockerfile (D46). */
export function requestImageBuild(ctx: Ctx, projectId: string): { jobId: number } {
  const cfg = ctx.store.require(projectId);
  if (!cfg.runtime.build) throw new BmError('NO_BUILD_CONFIG', t('setup.noBuild'));
  return { jobId: getQueue().enqueue('build_image', { projectId }) };
}

export async function buildImageExecutor(ctx: Ctx, job: JobRow, jc: JobContext): Promise<void> {
  const cfg = ctx.store.require(job.projectId!);
  await buildImage(cfg, jc.log, jc.signal);
  audit(ctx, { projectId: cfg.id, action: 'image.build', target: cfg.runtime.image, params: { context: cfg.runtime.build?.context, dockerfile: cfg.runtime.build?.dockerfile } });
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
