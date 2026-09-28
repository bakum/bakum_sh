import crypto from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { BuildView, ProjectConfig, ResolvedBranchScope } from '@bm/shared';
import type { Ctx } from '../context';
import { builds, type BranchRow, type BuildRow } from '../db/schema';
import { containerPoll, containerStates } from '../docker/state';

/**
 * Hash of everything that shapes the build container but not its database (spec 9.1 «конфигурация изменилась»):
 * image, env, mounts, command, network, repo mount, filestore mount, debug port, healthcheck.
 */
export function configHash(cfg: ProjectConfig, scope: ResolvedBranchScope, proxyPort: number): string {
  const r = cfg.runtime;
  const payload = {
    image: scope.image,
    env: scope.env,
    mounts: r.mounts,
    command: r.command,
    network: r.network,
    repoMount: r.repoMount,
    filestore: { hostDir: r.filestore.hostDir, containerDir: r.filestore.containerDir },
    debug: r.debug.containerPort,
    healthcheck: r.healthcheck,
    pg: cfg.postgres.internalHost,
    proxyPort,
    v: 1,
    // The code folder is mounted into the container (D33); only present when it is the user's folder.
    ...(scope.folder ? { folder: scope.folder } : {}),
  };
  return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

export function buildUrl(host: string, proxyPort: number | null): string {
  return `http://${host}${!proxyPort || proxyPort === 80 ? '' : `:${proxyPort}`}`;
}

export function toBuildView(
  ctx: Ctx,
  row: BuildRow,
  extra: { branchName: string; currentHash?: string | null; dropAfterDays?: number },
): BuildView {
  const cs = containerStates.get(row.composeProject);
  const isLive = row.live && (row.status === 'running' || row.status === 'stopped');
  const port = ctx.proxyPort ?? ctx.store.app.proxyPort;
  let dropAt: string | null = null;
  if (isLive && extra.dropAfterDays && extra.dropAfterDays > 0) {
    dropAt = new Date(new Date(row.finishedAt ?? row.createdAt).getTime() + extra.dropAfterDays * 86400_000).toISOString();
  }
  return {
    id: row.id,
    branchId: row.branchId,
    branchName: extra.branchName,
    projectId: row.projectId,
    stage: row.stage,
    number: row.number,
    commitSha: row.commitSha,
    commits: row.commits ?? [],
    trigger: row.trigger,
    kind: row.kind,
    dbSource: row.dbSource,
    dbName: row.dbName,
    debugPort: row.debugPort,
    status: row.status,
    tests: row.tests ?? null,
    steps: row.steps ?? [],
    logPath: row.logPath,
    configHash: row.configHash,
    configChanged: isLive && !!extra.currentHash && !!row.configHash && extra.currentHash !== row.configHash,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
    droppedAt: row.droppedAt,
    errorMessage: row.errorMessage,
    url: isLive || row.status === 'building' ? buildUrl(row.host, port) : null,
    containerState: !containerPoll.loaded ? null : isLive && cs && cs.buildId === row.id ? cs.state : isLive ? (cs?.state ?? 'missing') : null,
    isLive,
    dropAt,
  };
}

export function buildRow(ctx: Ctx, id: number): BuildRow | undefined {
  return ctx.db.select().from(builds).where(eq(builds.id, id)).get();
}

/** The live build of a branch: the one serving its URL (running or stopped). */
export function liveBuild(ctx: Ctx, branchId: number): BuildRow | undefined {
  return ctx.db
    .select()
    .from(builds)
    .where(and(eq(builds.branchId, branchId), eq(builds.live, true), inArray(builds.status, ['running', 'stopped'])))
    .orderBy(desc(builds.number))
    .get();
}

export function branchBuilds(ctx: Ctx, b: BranchRow): BuildRow[] {
  return ctx.db.select().from(builds).where(eq(builds.branchId, b.id)).orderBy(desc(builds.number)).all();
}
