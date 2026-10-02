import { eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import { builds } from '../db/schema';
import { authorEmails } from '../git';
import { repoDir } from '../git/worktrees';
import { bus } from '../events';
import { log } from '../util/logger';

/**
 * Builds recorded before D65 have commits without the author email, so History shows initials instead of avatars.
 * Fills the emails from the project's mirror once; a commit the mirror does not have (e.g. from the user's folder)
 * gets an empty email and is not looked up again.
 */
export async function backfillCommitEmails(ctx: Ctx): Promise<void> {
  const rows = ctx.db.select({ id: builds.id, projectId: builds.projectId, branchId: builds.branchId, commits: builds.commits }).from(builds).all();
  for (const row of rows) {
    const missing = (row.commits ?? []).filter((c) => c.email === undefined).map((c) => c.sha);
    if (!missing.length) continue;
    const cfg = ctx.store.get(row.projectId)?.config;
    if (!cfg) continue;
    let emails: Map<string, string>;
    try {
      emails = await authorEmails(repoDir(cfg), missing);
    } catch (err) {
      log().warn({ err, buildId: row.id }, 'commit emails backfill failed');
      continue;
    }
    const commits = row.commits.map((c) => (c.email === undefined ? { ...c, email: emails.get(c.sha) ?? '' } : c));
    ctx.db.update(builds).set({ commits }).where(eq(builds.id, row.id)).run();
    bus.emit({ type: 'build.changed', projectId: row.projectId, branchId: row.branchId, buildId: row.id });
  }
}
