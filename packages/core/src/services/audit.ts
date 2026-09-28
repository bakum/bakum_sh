import { desc, eq } from 'drizzle-orm';
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

export function listAudit(ctx: Ctx, projectId?: string, limit = 200) {
  const q = ctx.db.select().from(auditLog);
  const rows = (projectId ? q.where(eq(auditLog.projectId, projectId)) : q).orderBy(desc(auditLog.id)).limit(limit).all();
  return rows.map((r) => ({ id: r.id, at: r.at, projectId: r.projectId, action: r.action, target: r.target, result: r.result }));
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
