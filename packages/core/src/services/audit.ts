import { and, asc, desc, eq, gte, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import type { AuditList } from '@bm/shared';
import type { Ctx } from '../context';
import { auditLog } from '../db/schema';
import { nowIso } from '../util/time';
import { log } from '../util/logger';

export function audit(
  ctx: Ctx,
  e: { projectId?: string | null; action: string; target: string; params?: Record<string, unknown>; result?: string; diff?: string | null },
): void {
  try {
    ctx.db
      .insert(auditLog)
      .values({
        projectId: e.projectId ?? null,
        at: nowIso(),
        action: e.action,
        target: e.target,
        params: e.params ?? {},
        result: e.result ?? 'ok',
        diff: e.diff ?? null,
      })
      .run();
  } catch (err) {
    log().warn({ err }, 'audit write failed');
  }
}

export interface AuditQuery {
  projectId?: string;
  withApp: boolean;
  action?: string;
  q?: string;
  result?: 'ok' | 'error';
  since?: string;
  until?: string;
  offset: number;
  limit: number;
}

/** Audit Logs (spec 8.11): filtered page, newest first, with parameters and settings diffs. */
export function listAudit(ctx: Ctx, p: AuditQuery): AuditList {
  const scope = p.projectId
    ? p.withApp
      ? or(eq(auditLog.projectId, p.projectId), isNull(auditLog.projectId))
      : eq(auditLog.projectId, p.projectId)
    : undefined;
  const conds: (SQL | undefined)[] = [scope];
  if (p.action) conds.push(p.action.endsWith('.') ? sql`substr(${auditLog.action}, 1, ${p.action.length}) = ${p.action}` : eq(auditLog.action, p.action));
  if (p.q?.trim()) {
    const needle = p.q.trim().toLowerCase();
    conds.push(sql`(instr(ulower(${auditLog.target}), ${needle}) > 0 OR instr(ulower(${auditLog.params}), ${needle}) > 0)`);
  }
  if (p.result) conds.push(p.result === 'ok' ? eq(auditLog.result, 'ok') : ne(auditLog.result, 'ok'));
  if (p.since) conds.push(gte(auditLog.at, p.since));
  if (p.until) conds.push(lt(auditLog.at, p.until));
  const where = and(...conds);
  const total = ctx.db.select({ n: sql<number>`count(*)` }).from(auditLog).where(where).get()?.n ?? 0;
  const rows = ctx.db.select().from(auditLog).where(where).orderBy(desc(auditLog.id)).limit(p.limit).offset(p.offset).all();
  const actions = ctx.db
    .selectDistinct({ a: auditLog.action })
    .from(auditLog)
    .where(scope)
    .orderBy(asc(auditLog.action))
    .all()
    .map((r) => r.a);
  return {
    items: rows.map((r) => ({ id: r.id, at: r.at, projectId: r.projectId, action: r.action, target: r.target, params: r.params, result: r.result, diff: r.diff })),
    total,
    actions,
  };
}

/** Small line diff for settings changes (audit log). */
export function lineDiff(a: string, b: string): string {
  const x = a.split(/\r?\n/);
  const y = b.split(/\r?\n/);
  if (x.length * y.length > 4_000_000) return `(${x.length} → ${y.length} строк)`;
  const dp: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push(`- ${x[i++]}`);
    else out.push(`+ ${y[j++]}`);
  }
  while (i < x.length) out.push(`- ${x[i++]}`);
  while (j < y.length) out.push(`+ ${y[j++]}`);
  return out.join('\n');
}
