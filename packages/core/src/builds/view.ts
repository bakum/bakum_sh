import crypto from 'node:crypto';
import { and, desc, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import type { BuildView, MethodParamsParsed, ProjectConfig, ResolvedBranchScope } from '@bm/shared';
import type { Ctx } from '../context';
import { branches, builds, type BranchRow, type BuildRow } from '../db/schema';
import { containerPoll, containerStates } from '../docker/state';
import { resolveBranchScope } from '../config/effective';
import { lifecycleState } from './lifecycle-state';
import { dockerfileHash } from '../config/dockerfile';
import { buildUrl } from '../docker/compose';

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
    // Bumped when the generated container changes in a way settings do not show: v2 — the bm.* labels of D52, so live
    // builds get «конфигурация изменилась» and their «Применить» after the update.
    v: 2,
    // The code folder is mounted into the container (D33); only present when it is the user's folder.
    ...(scope.folder ? { folder: scope.folder } : {}),
    // An image built by the app (D46): a Dockerfile edit changes the container. Absent otherwise (hashes unchanged).
    ...(r.build && scope.image === r.image ? { imageBuild: { context: r.build.context, dockerfile: dockerfileHash(cfg) } } : {}),
  };
  return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

/** tests.log of a build: next to its build.log (`<slug>-<n>.log` → `<slug>-<n>.tests.log`). */
export const testsLogPath = (logPath: string): string => `${logPath.replace(/\.log$/, '')}.tests.log`;

export { buildUrl };

export function toBuildView(
  ctx: Ctx,
  row: BuildRow,
  extra: { branchName: string; currentHash?: string | null; dropAfterDays?: number; lastActiveAt?: string | null },
): BuildView {
  const cs = containerStates.get(row.composeProject);
  const isLive = row.live && (row.status === 'running' || row.status === 'stopped');
  const port = ctx.proxyPort ?? ctx.store.app.proxyPort;
  // D45: the date after which the live build may be dropped — counted from its last activity.
  const expiresAt = isLive
    ? lifecycleState({ running: false, startedAt: null, finishedAt: row.finishedAt ?? row.createdAt, lastActiveAt: extra.lastActiveAt ?? null, idleStopHours: 0, dropAfterDays: extra.dropAfterDays ?? 0, now: Date.now() }).expiresAt
    : null;
  const dropAt = expiresAt === null ? null : new Date(expiresAt).toISOString();
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

/** Builds (spec 8.11) and History: filtered page, newest first. */
export function listBuilds(ctx: Ctx, p: MethodParamsParsed<'builds.list'>): { items: BuildView[]; total: number } {
  const conds: SQL[] = [];
  if (p.projectId) conds.push(eq(builds.projectId, p.projectId));
  if (p.branchId) conds.push(eq(builds.branchId, p.branchId));
  if (p.stage) conds.push(eq(builds.stage, p.stage));
  if (p.status) conds.push(eq(builds.status, p.status));
  if (p.trigger) conds.push(eq(builds.trigger, p.trigger));
  // A JSON column may hold SQL NULL or the text 'null'.
  const noTests = sql`(${builds.tests} IS NULL OR ${builds.tests} = 'null')`;
  if (p.tests === 'none') conds.push(noTests);
  else if (p.tests) {
    const failed = sql`coalesce(json_extract(${builds.tests}, '$.failed'), 0) + coalesce(json_extract(${builds.tests}, '$.errors'), 0)`;
    conds.push(sql`NOT ${noTests}`, p.tests === 'failed' ? sql`${failed} > 0` : sql`${failed} = 0`);
  }
  if (p.since) conds.push(gte(builds.createdAt, p.since));
  if (p.until) conds.push(lt(builds.createdAt, p.until));
  const where = conds.length ? and(...conds) : undefined;
  const total = ctx.db.select({ n: sql<number>`count(*)` }).from(builds).where(where).get()?.n ?? 0;
  const rows = ctx.db.select().from(builds).where(where).orderBy(desc(builds.id)).limit(p.limit).offset(p.offset).all();
  const brs = new Map(ctx.db.select().from(branches).all().map((b) => [b.id, b]));
  // Live builds show their «may be dropped after» date (D45): it needs the branch's effective dropAfterDays.
  const dropDays = (r: BuildRow): number => {
    const br = brs.get(r.branchId);
    const cfg = r.live ? ctx.store?.get(r.projectId)?.config : undefined;
    return br && cfg ? resolveBranchScope(cfg, br.name, br.stage, br.overrides).scope.dropAfterDays : 0;
  };
  return {
    items: rows.map((r) => toBuildView(ctx, r, { branchName: brs.get(r.branchId)?.name ?? '?', dropAfterDays: dropDays(r), lastActiveAt: brs.get(r.branchId)?.lastActiveAt })),
    total,
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
