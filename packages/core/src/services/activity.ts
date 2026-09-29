import { PassThrough } from 'node:stream';
import { and, eq, inArray } from 'drizzle-orm';
import type { Ctx } from '../context';
import { branches, builds } from '../db/schema';
import { docker } from '../docker/client';
import { TRAEFIK_PROJECT } from '../docker/traefik';
import { runtimeState } from '../state';
import { log } from '../util/logger';

/**
 * Activity of builds (D45): the JSON access log of the shared Traefik (container stdout) is followed; each request to
 * a live build counts in `http_stats` (per build and minute, kept 24 h) and moves `branches.last_active_at`, which
 * drives `idleStopHours` / `dropAfterDays`. Traefik is shared by every profile of the app: it is only read here.
 */

export interface AccessEntry {
  /** Traefik router without the provider suffix: the build's compose project (see generateCompose). */
  router: string;
  path: string;
  status: number;
  durationMs: number;
  /** ISO time the request started. */
  at: string;
}

/** Requests that keep a tab open, not a person using the build: they are not activity. */
const BACKGROUND_PATHS = /^\/(websocket|longpolling|bus\/)/;

/** One line of the Traefik JSON access log; null for anything else (Traefik's own log, garbage). */
export function parseAccessLine(line: string): AccessEntry | null {
  const s = line.trim();
  if (!s.startsWith('{')) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
  const router = typeof j.RouterName === 'string' ? j.RouterName.replace(/@.*$/, '') : '';
  const at = typeof j.StartUTC === 'string' ? j.StartUTC : null;
  if (!router || !at) return null;
  return {
    router,
    path: typeof j.RequestPath === 'string' ? j.RequestPath : '/',
    status: Number(j.DownstreamStatus ?? j.OriginStatus ?? 0),
    durationMs: Number(j.Duration ?? 0) / 1e6,
    at,
  };
}

export const isBackgroundRequest = (path: string): boolean => BACKGROUND_PATHS.test(path);

interface Bucket {
  count: number;
  totalMs: number;
  maxMs: number;
  errors: number;
}

const FLUSH_MS = 30_000;
const KEEP_MS = 24 * 3_600_000;

export class ActivityCollector {
  private buckets = new Map<string, Bucket>();
  private lastActive = new Map<number, string>();
  private lastAt = '';
  private stream: NodeJS.ReadableStream | null = null;
  private retry: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  /** Router name → live build, refreshed on every flush (builds come and go). */
  private routes = new Map<string, { buildId: number; branchId: number }>();

  constructor(private readonly ctx: Ctx) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.lastAt = (this.ctx.sqlite.prepare("SELECT value FROM kv WHERE key = 'traefik-log-at'").get() as { value: string } | undefined)?.value ?? '';
    this.refreshRoutes();
    void this.follow();
    this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.retry = null;
    this.flushTimer = null;
    (this.stream as unknown as { destroy?: () => void } | null)?.destroy?.();
    this.stream = null;
    this.flush();
  }

  private routesAt = 0;

  private refreshRoutes(): void {
    this.routesAt = Date.now();
    const live = this.ctx.db.select().from(builds).where(and(eq(builds.live, true), inArray(builds.status, ['running', 'stopped']))).all();
    this.routes = new Map(live.map((b) => [b.composeProject.replace(/[^a-z0-9-]/g, '-'), { buildId: b.id, branchId: b.branchId }]));
  }

  /** Follows `docker logs` of Traefik from the last seen time; reconnects when Traefik is recreated or Docker restarts. */
  private async follow(): Promise<void> {
    if (this.stopped) return;
    const again = () => {
      this.stream = null;
      if (!this.stopped) this.retry = setTimeout(() => void this.follow(), 10_000);
    };
    try {
      if (!runtimeState.docker.ok) return again();
      const lastMs = this.lastAt ? new Date(this.lastAt).getTime() : 0;
      // Not older than a day: a long pause would replay a huge log for nothing (the stats keep 24 h anyway).
      const since = Math.floor(Math.max(lastMs, Date.now() - KEEP_MS) / 1000);
      const s = (await docker.getContainer(TRAEFIK_PROJECT).logs({ follow: true, stdout: true, stderr: false, since })) as NodeJS.ReadableStream;
      if (this.stopped) {
        (s as unknown as { destroy?: () => void }).destroy?.();
        return;
      }
      this.stream = s;
      const out = new PassThrough();
      docker.modem.demuxStream(s, out, new PassThrough());
      let partial = '';
      out.on('data', (d: Buffer) => {
        const parts = (partial + d.toString('utf8')).split('\n');
        partial = parts.pop() ?? '';
        for (const l of parts) this.onLine(l);
      });
      s.on('end', again);
      s.on('error', again);
    } catch (err) {
      log().debug({ err }, 'traefik access log unavailable');
      again();
    }
  }

  onLine(line: string): void {
    const e = parseAccessLine(line);
    // `since` has second precision: lines already counted before a reconnect are skipped by their start time.
    if (!e || e.at <= this.lastAt) return;
    this.lastAt = e.at;
    let route = this.routes.get(e.router);
    // A build that became live after the last refresh: re-read the routes (at most every 5 s for unknown routers).
    if (!route && Date.now() - this.routesAt > 5000) {
      this.refreshRoutes();
      route = this.routes.get(e.router);
    }
    if (!route || isBackgroundRequest(e.path)) return;
    const key = `${route.buildId}|${e.at.slice(0, 16)}`;
    const b = this.buckets.get(key) ?? { count: 0, totalMs: 0, maxMs: 0, errors: 0 };
    b.count++;
    b.totalMs += e.durationMs;
    b.maxMs = Math.max(b.maxMs, e.durationMs);
    if (e.status >= 500) b.errors++;
    this.buckets.set(key, b);
    const prev = this.lastActive.get(route.branchId);
    if (!prev || e.at > prev) this.lastActive.set(route.branchId, e.at);
  }

  /** Writes the minute buckets and the last activity of branches; drops stats older than a day. */
  flush(): void {
    try {
      const upsert = this.ctx.sqlite.prepare(
        `INSERT INTO http_stats (build_id, minute, count, total_ms, max_ms, errors) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(build_id, minute) DO UPDATE SET count = count + excluded.count, total_ms = total_ms + excluded.total_ms,
           max_ms = max(max_ms, excluded.max_ms), errors = errors + excluded.errors`,
      );
      this.ctx.sqlite.transaction(() => {
        for (const [key, b] of this.buckets) {
          const [id, minute] = key.split('|');
          upsert.run(Number(id), minute, b.count, b.totalMs, b.maxMs, b.errors);
        }
        for (const [branchId, at] of this.lastActive) {
          const cur = this.ctx.db.select({ a: branches.lastActiveAt }).from(branches).where(eq(branches.id, branchId)).get();
          if (cur && (!cur.a || cur.a < at)) this.ctx.db.update(branches).set({ lastActiveAt: at }).where(eq(branches.id, branchId)).run();
        }
        const cutoff = new Date(Date.now() - KEEP_MS).toISOString().slice(0, 16);
        this.ctx.sqlite.prepare('DELETE FROM http_stats WHERE minute < ?').run(cutoff);
        if (this.lastAt) this.ctx.sqlite.prepare("INSERT OR REPLACE INTO kv(key, value) VALUES ('traefik-log-at', ?)").run(this.lastAt);
      })();
      this.buckets.clear();
      this.lastActive.clear();
    } catch (err) {
      log().warn({ err }, 'activity flush failed');
    }
    this.refreshRoutes();
  }
}

let collector: ActivityCollector | null = null;
export const setActivityCollector = (c: ActivityCollector): void => {
  collector = c;
};
export const activityCollector = (): ActivityCollector | null => collector;
