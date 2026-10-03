import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { BmError, type MonitorPeriod, type MonitorView } from '@bm/shared';
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
import { t } from '../i18n';

/**
 * Monitor (spec 8.9, D45, D74): CPU / RAM of running live builds sampled every 30 s into `resource_stats`, requests
 * from `http_stats` (both kept 7 days), database and filestore sizes (cached for 5 minutes). Charts cover a period
 * (1 h … 7 d) of the branch, across its builds, averaged into at most ~120 points.
 */

const SAMPLE_MS = 30_000;
const KEEP_MS = 7 * 24 * 3_600_000;
const PRUNE_MS = 3_600_000;
/** Period length and bucket (s); 1 h keeps the raw 30 s samples and per-minute requests. */
const PERIODS: Record<MonitorPeriod, { ms: number; bucketSec: number }> = {
  '1h': { ms: 3_600_000, bucketSec: 30 },
  '6h': { ms: 6 * 3_600_000, bucketSec: 180 },
  '24h': { ms: 24 * 3_600_000, bucketSec: 720 },
  '7d': { ms: 7 * 24 * 3_600_000, bucketSec: 5040 },
};
let prunedAt = 0;
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
  const insert = ctx.sqlite.prepare('INSERT OR REPLACE INTO resource_stats (build_id, branch_id, at, cpu, mem_mb) VALUES (?, ?, ?, ?, ?)');
  await Promise.all(
    live.map(async (b) => {
      const cs = containerStates.get(b.composeProject);
      if (!cs || cs.buildId !== b.id || cs.state !== 'running') return;
      const raw = (await docker.getContainer(cs.id).stats({ stream: false }).catch(() => null)) as Parameters<typeof statsSample>[0] | null;
      if (!raw) return;
      const s = statsSample(raw);
      insert.run(b.id, b.branchId, new Date().toISOString().slice(0, 19), s.cpu, s.memMb);
      if (s.limitMb) memLimits.set(b.id, s.limitMb);
    }),
  );
  if (Date.now() - prunedAt > PRUNE_MS) {
    prunedAt = Date.now();
    ctx.sqlite.prepare('DELETE FROM resource_stats WHERE at < ?').run(new Date(Date.now() - KEEP_MS).toISOString().slice(0, 19));
  }
}

function currentSample(ctx: Ctx, buildId: number, running: boolean): MonitorView['current'] {
  if (!running) return null;
  const r = ctx.sqlite.prepare('SELECT at, cpu, mem_mb AS memMb FROM resource_stats WHERE build_id = ? ORDER BY at DESC LIMIT 1').get(buildId) as
    | { at: string; cpu: number; memMb: number }
    | undefined;
  const at = r ? `${r.at}Z` : null;
  return r && at && Date.now() - Date.parse(at) < 3 * SAMPLE_MS ? { at, cpu: r.cpu, memMb: r.memMb } : null;
}

type ReqRow = { minute: string; count: number; total: number; max: number; errors: number };

/** Averages 30 s samples into buckets of `bucketSec` (a bucket is stamped with its start). */
export function bucketResources(rows: { at: string; cpu: number; memMb: number }[], bucketSec: number): MonitorView['resources'] {
  if (bucketSec <= 30) return rows.map((r) => ({ at: `${r.at.slice(0, 19)}Z`, cpu: r.cpu, memMb: r.memMb }));
  const step = bucketSec * 1000;
  const acc = new Map<number, { cpu: number; mem: number; n: number }>();
  for (const r of rows) {
    const k = Math.floor(Date.parse(`${r.at.slice(0, 19)}Z`) / step) * step;
    const a = acc.get(k) ?? { cpu: 0, mem: 0, n: 0 };
    a.cpu += r.cpu;
    a.mem += r.memMb;
    a.n++;
    acc.set(k, a);
  }
  return [...acc.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([k, a]) => ({ at: new Date(k).toISOString(), cpu: Math.round((a.cpu / a.n) * 10) / 10, memMb: Math.round(a.mem / a.n) }));
}

/** Sums per-minute requests into buckets of `bucketSec` (at least a minute). */
export function bucketRequests(rows: ReqRow[], bucketSec: number): MonitorView['requests'] {
  const step = Math.max(60, bucketSec) * 1000;
  const acc = new Map<number, ReqRow>();
  for (const r of rows) {
    const k = Math.floor(Date.parse(`${r.minute}:00Z`) / step) * step;
    const a = acc.get(k) ?? { minute: new Date(k).toISOString().slice(0, 16), count: 0, total: 0, max: 0, errors: 0 };
    a.count += r.count;
    a.total += r.total;
    a.max = Math.max(a.max, r.max);
    a.errors += r.errors;
    acc.set(k, a);
  }
  return [...acc.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([, r]) => ({ minute: r.minute, count: r.count, avgMs: r.count ? Math.round(r.total / r.count) : 0, maxMs: Math.round(r.max), errors: r.errors }));
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

export async function monitorView(ctx: Ctx, buildId: number, period: MonitorPeriod = '1h'): Promise<MonitorView> {
  const b = ctx.db.select().from(builds).where(eq(builds.id, buildId)).get();
  if (!b) throw new BmError('NO_BUILD', t('common.noBuild'));
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
  const p = PERIODS[period];
  const to = Date.now();
  const from = to - p.ms;
  // The chart follows the branch over the period, across rebuilds: every build of the branch counts.
  const ids = ctx.db.select({ id: builds.id }).from(builds).where(eq(builds.branchId, b.branchId)).all().map((x) => x.id);
  const rows = ctx.sqlite
    .prepare(
      `SELECT minute, sum(count) AS count, sum(total_ms) AS total, max(max_ms) AS max, sum(errors) AS errors FROM http_stats
       WHERE build_id IN (${ids.map(() => '?').join(',') || 'NULL'}) AND minute >= ? GROUP BY minute ORDER BY minute`,
    )
    .all(...ids, new Date(from).toISOString().slice(0, 16)) as ReqRow[];
  const samples = ctx.sqlite
    .prepare('SELECT at, cpu, mem_mb AS memMb FROM resource_stats WHERE branch_id = ? AND at >= ? ORDER BY at')
    .all(b.branchId, new Date(from).toISOString().slice(0, 19)) as { at: string; cpu: number; memMb: number }[];

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
    period,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    bucketSec: p.bucketSec,
    resources: bucketResources(samples, p.bucketSec),
    current: currentSample(ctx, b.id, running),
    memLimitMb: memLimits.get(b.id) ?? null,
    requests: bucketRequests(rows, p.bucketSec),
    dbSizeBytes: sizes.db,
    filestoreBytes: sizes.fs,
    lastActiveAt: br?.lastActiveAt ?? null,
    idleStopAt: iso(st.stopAt),
    expiresAt: iso(st.expiresAt),
    idleStopHours: scope?.idleStopHours ?? 0,
    dropAfterDays: scope?.dropAfterDays ?? 0,
  };
}
