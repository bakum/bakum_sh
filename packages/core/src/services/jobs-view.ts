import { and, desc, eq, inArray } from 'drizzle-orm';
import type { JobView } from '@bm/shared';
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
