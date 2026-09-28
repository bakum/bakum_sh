import fs from 'node:fs';
import path from 'node:path';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { BmError, type JobView } from '@bm/shared';
import type { Ctx } from '../context';
import { jobs, type JobRow } from '../db/schema';

export function jobView(r: JobRow): JobView {
  return {
    id: r.id,
    type: r.type as JobView['type'],
    status: r.status,
    projectId: r.projectId,
    branchId: r.branchId,
    buildId: r.buildId,
    params: r.params,
    error: r.error,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  };
}

/** Tail of a job log (logs/jobs/<id>-<type>.log) without the timestamps. */
export function jobLog(ctx: Ctx, jobId: number, tail: number): { lines: string[] } {
  const r = ctx.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!r) throw new BmError('NO_JOB', 'Задача не найдена');
  const file = path.join(ctx.logsDir, 'jobs', `${r.id}-${r.type}.log`);
  if (!fs.existsSync(file)) return { lines: [] };
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return { lines: lines.slice(-tail).map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, '')) };
}

export function listJobs(ctx: Ctx, p: { projectId?: string; active?: boolean; limit?: number }): JobView[] {
  const conds = [];
  if (p.projectId) conds.push(eq(jobs.projectId, p.projectId));
  if (p.active) conds.push(inArray(jobs.status, ['queued', 'running']));
  return ctx.db
    .select()
    .from(jobs)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(jobs.id))
    .limit(p.limit ?? 100)
    .all()
    .map(jobView);
}
