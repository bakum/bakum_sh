import { eq } from 'drizzle-orm';
import type { Ctx } from './context';
import { branches, builds, snapshots } from './db/schema';
import type { OwnedRegistry } from './safety';

/** What the SQLite registry says the app created for a project (input to assertOwned). */
export function ownedRegistry(ctx: Ctx, projectId: string): OwnedRegistry {
  const b = ctx.db.select({ db: builds.dbName, cp: builds.composeProject, id: builds.id }).from(builds).where(eq(builds.projectId, projectId)).all();
  const dbNames = new Set<string>();
  for (const r of b) {
    dbNames.add(r.db);
    dbNames.add(`${r.db}_test`);
  }
  const ids = new Set(b.map((r) => r.id));
  for (const s of ctx.db.select().from(snapshots).all()) if (ids.has(s.buildId)) dbNames.add(s.dbName);
  const wts = ctx.db.select({ p: branches.worktreePath }).from(branches).where(eq(branches.projectId, projectId)).all();
  return {
    dbNames,
    composeProjects: new Set(b.map((r) => r.cp)),
    worktrees: new Set(wts.map((w) => w.p).filter((p): p is string => !!p)),
  };
}
