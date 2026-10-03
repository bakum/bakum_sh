import { and, eq, inArray } from 'drizzle-orm';
import { isLegacyProject } from '@bm/shared';
import type { Ctx } from '../context';
import { branches, builds, jobs } from '../db/schema';
import { docker } from '../docker/client';
import { containerStates } from '../docker/state';
import { resolveBranchScope } from '../config/effective';
import { getQueue } from '../jobs/queue';
import { audit } from './audit';
import { notify } from './notify';
import { log } from '../util/logger';
import { lifecycleState } from '../builds/lifecycle-state';
import { t } from '../i18n';

/**
 * Lifecycle tick (D45): every 5 minutes live builds past `idleStopHours` are stopped, and a build past its
 * `dropAfterDays` gives one «можно отбросить» notification (nothing is dropped automatically).
 */
// BM_LIFECYCLE_TICK_MS exists only for the manual check (scripts/check-monitor.mjs): minutes instead of hours.
const TICK_MS = Number(process.env.BM_LIFECYCLE_TICK_MS) || 5 * 60_000;
let timer: NodeJS.Timeout | null = null;

export function startLifecycle(ctx: Ctx): void {
  stopLifecycle();
  const loop = async (): Promise<void> => {
    await lifecycleTick(ctx).catch((err) => log().warn({ err }, 'lifecycle tick failed'));
    timer = setTimeout(() => void loop(), TICK_MS);
  };
  timer = setTimeout(() => void loop(), Math.min(60_000, TICK_MS));
}

export function stopLifecycle(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

/** Container start time of a running live build (docker inspect), for the idle timer. */
async function containerStartedAt(composeProject: string): Promise<string | null> {
  const cs = containerStates.get(composeProject);
  if (!cs || cs.state !== 'running') return null;
  const info = await docker.getContainer(cs.id).inspect().catch(() => null);
  return info?.State.StartedAt ?? null;
}

async function lifecycleTick(ctx: Ctx): Promise<void> {
  const live = ctx.db.select().from(builds).where(and(eq(builds.live, true), inArray(builds.status, ['running', 'stopped']))).all();
  const busy = new Set(
    ctx.db
      .select({ b: jobs.branchId })
      .from(jobs)
      .where(inArray(jobs.status, ['queued', 'running']))
      .all()
      .map((j) => j.b),
  );
  const now = Date.now();
  for (const b of live) {
    const cfg = ctx.store.get(b.projectId)?.config;
    if (!cfg || !cfg.enabled || isLegacyProject(cfg)) continue;
    const br = ctx.db.select().from(branches).where(eq(branches.id, b.branchId)).get();
    if (!br || busy.has(br.id)) continue;
    const scope = resolveBranchScope(cfg, br.name, br.stage, br.overrides).scope;
    const cs = containerStates.get(b.composeProject);
    const running = !!cs && cs.buildId === b.id && cs.state === 'running';
    const st = lifecycleState({
      running,
      startedAt: running && scope.idleStopHours > 0 ? await containerStartedAt(b.composeProject) : null,
      finishedAt: b.finishedAt,
      lastActiveAt: br.lastActiveAt,
      idleStopHours: scope.idleStopHours,
      dropAfterDays: scope.dropAfterDays,
      now,
    });
    if (st.stopNow) {
      log().info({ build: b.composeProject }, 'idle stop');
      getQueue().enqueue('stop', { projectId: b.projectId, branchId: b.branchId, buildId: b.id }, { reason: 'idle' });
      audit(ctx, { projectId: b.projectId, action: 'build.idle-stop', target: `${b.composeProject}#${b.number}`, params: { idleStopHours: scope.idleStopHours } });
    }
    const key = `drop-warned:${b.id}`;
    if (st.expired && !ctx.sqlite.prepare('SELECT 1 FROM kv WHERE key = ?').get(key)) {
      ctx.sqlite.prepare('INSERT OR REPLACE INTO kv(key, value) VALUES (?, ?)').run(key, new Date(now).toISOString());
      audit(ctx, { projectId: b.projectId, action: 'build.expired', target: `${b.composeProject}#${b.number}`, params: { dropAfterDays: scope.dropAfterDays } });
      notify(
        ctx,
        'buildExpired',
        t('lifecycle.expiredTitle', { branch: br.name }),
        t('lifecycle.expiredBody', { number: b.number, days: scope.dropAfterDays }),
        { route: `/projects/${b.projectId}/branches/${br.id}/history` },
      );
    }
  }
}
