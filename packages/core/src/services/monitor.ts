import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { BmError, type MonitorView } from '@bm/shared';
import type { Ctx } from '../context';
import { branches, builds } from '../db/schema';
import { docker } from '../docker/client';
import { containerStates } from '../docker/state';
import { resolveBranchScope } from '../config/effective';
import { runtimeState } from '../state';
import * as pg from '../pg';
import { treeSize } from '../util/fs-tree';
import { log } from '../util/logger';
import { lifecycleState } from '../builds/lifecycle-state';

/**
 * Monitor (spec 8.9, D45): CPU / RAM of running live builds sampled every 30 s into an in-memory ring (the last hour,
 * lost on a Core restart), requests from `http_stats`, database and filestore sizes (cached for 5 minutes).
 */

interface Sample {
  at: string;
  cpu: number;
  memMb: number;
}

const SAMPLE_MS = 30_000;
const KEEP = 120;
const samples = new Map<number, Sample[]>();
const memLimits = new Map<number, number>();
const sizeCache = new Map<number, { at: number; db: number | null; fs: number | null }>();
let timer: NodeJS.Timeout | null = null;

/** CPU % (100 = one core) and RAM (without the page cache) of one `docker stats` sample. */
export function statsSample(s: {
  cpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
  memory_stats?: { usage?: number; limit?: number; stats?: { inactive_file?: number; cache?: number } };
}): { cpu: number; memMb: number; limitMb: number | null } {
  const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage ?? 0) - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const sysDelta = (s.cpu_stats?.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 0);
  const cpu = sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * (s.cpu_stats?.online_cpus ?? 1) * 100 : 0;
  const m = s.memory_stats;
  const used = Math.max(0, (m?.usage ?? 0) - (m?.stats?.inactive_file ?? m?.stats?.cache ?? 0));
  return { cpu: Math.round(cpu * 10) / 10, memMb: Math.round(used / 1048576), limitMb: m?.limit ? Math.round(m.limit / 1048576) : null };
}

async function sampleAll(ctx: Ctx): Promise<void> {
  if (!runtimeState.docker.ok) return;
  const live = ctx.db.select().from(builds).where(and(eq(builds.live, true), eq(builds.status, 'running'))).all();
  const ids = new Set(live.map((b) => b.id));
  for (const id of samples.keys()) if (!ids.has(id)) samples.delete(id);
  await Promise.all(
    live.map(async (b) => {
      const cs = containerStates.get(b.composeProject);
      if (!cs || cs.buildId !== b.id || cs.state !== 'running') return;
      const raw = (await docker.getContainer(cs.id).stats({ stream: false }).catch(() => null)) as Parameters<typeof statsSample>[0] | null;
      if (!raw) return;
      const s = statsSample(raw);
      const list = samples.get(b.id) ?? [];
      list.push({ at: new Date().toISOString(), cpu: s.cpu, memMb: s.memMb });
      if (list.length > KEEP) list.splice(0, list.length - KEEP);
      samples.set(b.id, list);
      if (s.limitMb) memLimits.set(b.id, s.limitMb);
    }),
  );
}

export function startMonitor(ctx: Ctx): void {
  stopMonitor();
  const loop = async (): Promise<void> => {
    await sampleAll(ctx).catch((err) => log().debug({ err }, 'monitor sample failed'));
    timer = setTimeout(() => void loop(), SAMPLE_MS);
  };
  void loop();
}

export function stopMonitor(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

export async function monitorView(ctx: Ctx, buildId: number): Promise<MonitorView> {
  const b = ctx.db.select().from(builds).where(eq(builds.id, buildId)).get();
  if (!b) throw new BmError('NO_BUILD', 'Сборка не найдена');
  const cfg = ctx.store.require(b.projectId);
  const br = ctx.db.select().from(branches).where(eq(branches.id, b.branchId)).get();
  const scope = br ? resolveBranchScope(cfg, br.name, br.stage, br.overrides).scope : null;
  const cs = containerStates.get(b.composeProject);
  const running = !!cs && cs.buildId === b.id && cs.state === 'running';

  let sizes = sizeCache.get(b.id);
  if (!sizes || Date.now() - sizes.at > 300_000) {
    sizes = { at: Date.now(), db: await pg.dbSize(cfg.postgres, b.dbName), fs: await treeSize(path.join(cfg.runtime.filestore.hostDir, b.dbName)) };
    sizeCache.set(b.id, sizes);
  }
  const since = new Date(Date.now() - 3_600_000).toISOString().slice(0, 16);
  // The live build of an `update` chain shares the database, and its requests: all builds on the same database count.
  const sameDb = ctx.db.select({ id: builds.id }).from(builds).where(and(eq(builds.projectId, b.projectId), eq(builds.dbName, b.dbName))).all().map((x) => x.id);
  const rows = ctx.sqlite
    .prepare(
      `SELECT minute, sum(count) AS count, sum(total_ms) AS total, max(max_ms) AS max, sum(errors) AS errors FROM http_stats
       WHERE build_id IN (${sameDb.map(() => '?').join(',') || 'NULL'}) AND minute >= ? GROUP BY minute ORDER BY minute`,
    )
    .all(...sameDb, since) as { minute: string; count: number; total: number; max: number; errors: number }[];

  let startedAt: string | null = null;
  if (running && scope && scope.idleStopHours > 0) startedAt = (await docker.getContainer(cs!.id).inspect().catch(() => null))?.State.StartedAt ?? null;
  const st = lifecycleState({
    running,
    startedAt,
    finishedAt: b.finishedAt,
    lastActiveAt: br?.lastActiveAt ?? null,
    idleStopHours: scope?.idleStopHours ?? 0,
    dropAfterDays: scope?.dropAfterDays ?? 0,
    now: Date.now(),
  });
  const iso = (n: number | null) => (n === null ? null : new Date(n).toISOString());
  return {
    buildId: b.id,
    running,
    resources: samples.get(b.id) ?? [],
    memLimitMb: memLimits.get(b.id) ?? null,
    requests: rows.map((r) => ({ minute: r.minute, count: r.count, avgMs: r.count ? Math.round(r.total / r.count) : 0, maxMs: Math.round(r.max), errors: r.errors })),
    dbSizeBytes: sizes.db,
    filestoreBytes: sizes.fs,
    lastActiveAt: br?.lastActiveAt ?? null,
    idleStopAt: iso(st.stopAt),
    expiresAt: iso(st.expiresAt),
    idleStopHours: scope?.idleStopHours ?? 0,
    dropAfterDays: scope?.dropAfterDays ?? 0,
  };
}
