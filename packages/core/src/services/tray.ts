import { and, eq, inArray, desc } from 'drizzle-orm';
import type { TrayProject } from '@bm/shared';
import type { Ctx } from '../context';
import { branches, builds, jobs } from '../db/schema';
import { buildUrl } from '../builds/view';

let last = '';

/** Tray icon state and menu (spec 7): ok / building / error and live builds per project. */
export function publishTray(ctx: Ctx): void {
  const port = ctx.proxyPort ?? ctx.store.app.proxyPort;
  const menu: TrayProject[] = [];
  for (const e of ctx.store.list()) {
    const rows = ctx.db
      .select({ b: builds, name: branches.name })
      .from(builds)
      .innerJoin(branches, eq(branches.id, builds.branchId))
      .where(and(eq(builds.projectId, e.id), eq(builds.live, true), inArray(builds.status, ['running', 'stopped'])))
      .all();
    menu.push({
      id: e.id,
      name: e.config?.name ?? e.id,
      builds: rows.map((r) => ({ buildId: r.b.id, branchId: r.b.branchId, branch: r.name, status: r.b.status, url: buildUrl(r.b.host, port) })),
    });
  }
  const building = !!ctx.db.select().from(jobs).where(inArray(jobs.status, ['running'])).get();
  const lastBuilds = ctx.db.select().from(builds).orderBy(desc(builds.id)).limit(50).all();
  const latestPerBranch = new Map<number, (typeof lastBuilds)[number]>();
  for (const b of lastBuilds) if (!latestPerBranch.has(b.branchId) && b.status !== 'dropped') latestPerBranch.set(b.branchId, b);
  const failed = [...latestPerBranch.values()].some((b) => b.status === 'failed');
  const state = building ? 'building' : failed ? 'error' : 'ok';
  const payload = JSON.stringify({ state, menu });
  if (payload === last) return;
  last = payload;
  ctx.toMain({ kind: 'tray', state, menu });
}
