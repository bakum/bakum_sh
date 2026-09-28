import fs from 'node:fs';
import path from 'node:path';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { BmError, type JobType } from '@bm/shared';
import type { Ctx } from '../context';
import { jobs, type JobRow } from '../db/schema';
import { bus } from '../events';
import { runtimeState } from '../state';
import { log } from '../util/logger';
import { nowIso } from '../util/time';

export interface JobContext {
  signal: AbortSignal;
  /** Appends a line to the job log file. */
  log: (line: string) => void;
}

export type Executor = (ctx: Ctx, job: JobRow, jc: JobContext) => Promise<void>;

/** Job types that count against maxParallelBuilds. */
const HEAVY: ReadonlySet<string> = new Set(['build', 'import_backup']);

/**
 * Persistent job queue (spec 8.3 «Очередь»): one active job per branch, maxParallelBuilds heavy jobs
 * over all projects, one fetch per project. State lives in SQLite so a Core restart can mark
 * unfinished jobs `interrupted`.
 */
export class JobQueue {
  private executors = new Map<string, Executor>();
  private running = new Map<number, AbortController>();
  private pumping = false;
  private stopped = false;

  constructor(private readonly ctx: Ctx) {}

  register(type: JobType, ex: Executor): void {
    this.executors.set(type, ex);
  }

  enqueue(type: JobType, ref: { projectId?: string | null; branchId?: number | null; buildId?: number | null }, params: Record<string, unknown> = {}): number {
    if (type === 'fetch') {
      const dup = this.ctx.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.type, 'fetch'), eq(jobs.projectId, ref.projectId ?? ''), eq(jobs.status, 'queued')))
        .get();
      if (dup) return dup.id;
    }
    const row = this.ctx.db
      .insert(jobs)
      .values({
        type,
        status: 'queued',
        projectId: ref.projectId ?? null,
        branchId: ref.branchId ?? null,
        buildId: ref.buildId ?? null,
        params,
        createdAt: nowIso(),
      })
      .returning()
      .get();
    bus.emit({ type: 'job.changed', jobId: row.id, projectId: row.projectId ?? undefined, branchId: row.branchId ?? undefined });
    setImmediate(() => void this.pump());
    return row.id;
  }

  /** Active (queued/running) job of a branch, if any. */
  activeForBranch(branchId: number): JobRow | undefined {
    return this.ctx.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.branchId, branchId), inArray(jobs.status, ['queued', 'running'])))
      .orderBy(asc(jobs.id))
      .get();
  }

  cancel(jobId: number): void {
    const row = this.ctx.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    if (!row) throw new BmError('NO_JOB', 'Задача не найдена');
    if (row.status === 'queued') {
      this.finish(row, 'cancelled', 'Отменена пользователем');
    } else if (row.status === 'running') {
      this.running.get(jobId)?.abort();
    }
  }

  cancelAll(): void {
    for (const r of this.ctx.db.select().from(jobs).where(eq(jobs.status, 'queued')).all()) this.finish(r, 'cancelled', 'Отменена при выходе');
    for (const c of this.running.values()) c.abort();
  }

  get activeCount(): number {
    return this.running.size;
  }

  async drain(timeoutMs: number): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (this.running.size && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
  }

  stop(): void {
    this.stopped = true;
  }

  async pump(): Promise<void> {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    try {
      const all = this.ctx.db.select().from(jobs).where(inArray(jobs.status, ['queued', 'running'])).orderBy(asc(jobs.id)).all();
      const busyBranches = new Set(all.filter((j) => j.status === 'running' && j.branchId).map((j) => j.branchId!));
      const busyFetch = new Set(all.filter((j) => j.status === 'running' && j.type === 'fetch').map((j) => j.projectId));
      let heavy = all.filter((j) => j.status === 'running' && HEAVY.has(j.type)).length;
      const max = this.ctx.store.app.limits.maxParallelBuilds;
      for (const j of all) {
        if (j.status !== 'queued') continue;
        if (j.branchId && busyBranches.has(j.branchId)) continue;
        if (j.type === 'fetch' && busyFetch.has(j.projectId)) continue;
        if (HEAVY.has(j.type)) {
          if (heavy >= max) continue;
          heavy++;
        }
        if (j.branchId) busyBranches.add(j.branchId);
        if (j.type === 'fetch') busyFetch.add(j.projectId);
        this.start(j);
      }
      const queued = all.filter((j) => j.status === 'queued').length;
      runtimeState.queue = { running: this.running.size, queued: Math.max(0, queued - this.running.size) };
    } finally {
      this.pumping = false;
    }
    this.reportBusy();
  }

  private start(j: JobRow): void {
    const ex = this.executors.get(j.type);
    if (!ex) {
      this.finish(j, 'failed', `Нет исполнителя для задачи ${j.type}`);
      return;
    }
    const ac = new AbortController();
    this.running.set(j.id, ac);
    this.ctx.db.update(jobs).set({ status: 'running', startedAt: nowIso() }).where(eq(jobs.id, j.id)).run();
    bus.emit({ type: 'job.changed', jobId: j.id, projectId: j.projectId ?? undefined, branchId: j.branchId ?? undefined });
    const logFile = path.join(this.ctx.logsDir, 'jobs', `${j.id}-${j.type}.log`);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const stream = fs.createWriteStream(logFile, { flags: 'a' });
    const jc: JobContext = {
      signal: ac.signal,
      log: (line) => stream.write(`${new Date().toISOString()} ${line}\n`),
    };
    jc.log(`job ${j.id} ${j.type} ${JSON.stringify(j.params)}`);
    void (async () => {
      try {
        await ex(this.ctx, { ...j, status: 'running' }, jc);
        this.finish(j, 'success', null);
      } catch (err) {
        const cancelled = ac.signal.aborted || (err as BmError).code === 'CANCELLED';
        const msg = (err as Error).message;
        jc.log(`ERROR ${msg}`);
        if (!cancelled) log().warn({ err, job: j.id, type: j.type }, 'job failed');
        this.finish(j, cancelled ? 'cancelled' : 'failed', msg);
      } finally {
        stream.end();
        this.running.delete(j.id);
        setImmediate(() => void this.pump());
      }
    })();
  }

  private finish(j: JobRow, status: JobRow['status'], error: string | null): void {
    this.ctx.db.update(jobs).set({ status, error, finishedAt: nowIso() }).where(eq(jobs.id, j.id)).run();
    bus.emit({ type: 'job.changed', jobId: j.id, projectId: j.projectId ?? undefined, branchId: j.branchId ?? undefined });
    this.reportBusy();
  }

  private lastBusy = -1;
  private reportBusy(): void {
    const n = this.running.size;
    if (n !== this.lastBusy) {
      this.lastBusy = n;
      this.ctx.toMain({ kind: 'busy', activeJobs: n });
    }
  }

  /** After a Core restart: jobs left `running`/`queued` are interrupted (spec 8.12). Returns them. */
  interruptStale(): JobRow[] {
    const stale = this.ctx.db.select().from(jobs).where(inArray(jobs.status, ['running', 'queued'])).all();
    for (const j of stale) {
      this.ctx.db
        .update(jobs)
        .set({ status: 'interrupted', error: 'Прервана: приложение или Core было остановлено во время выполнения', finishedAt: nowIso() })
        .where(eq(jobs.id, j.id))
        .run();
    }
    return stale;
  }
}

let queue: JobQueue | null = null;
export const setQueue = (q: JobQueue): void => {
  queue = q;
};
export const getQueue = (): JobQueue => {
  if (!queue) throw new Error('queue not initialized');
  return queue;
};
