import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { BmError } from '@bm/shared';
import type { Ctx } from '../context';
import { branches, builds, projects, type JobRow } from '../db/schema';
import { getQueue, type JobContext } from '../jobs/queue';
import { dropBuildResources } from '../builds/drop';
import { removeWorktree } from '../git/worktrees';
import { audit } from './audit';
import { bus } from '../events';
import { toPosix } from '../util/paths';

/** Everything the project owns (spec 8.1 «Удаление проекта»); the git repository itself is never touched. */
export function projectDeletePreview(ctx: Ctx, projectId: string) {
  const cfg = ctx.store.require(projectId);
  const rows = ctx.db.select().from(builds).where(eq(builds.projectId, projectId)).all().filter((b) => b.status !== 'dropped');
  const brs = ctx.db.select().from(branches).where(eq(branches.projectId, projectId)).all();
  return {
    builds: rows.map((b) => `${b.composeProject} #${b.number} (${b.status})`),
    databases: [...new Set(rows.map((b) => b.dbName))],
    filestores: [...new Set(rows.map((b) => toPosix(path.join(cfg.runtime.filestore.hostDir, b.dbName))))].filter((p) => fs.existsSync(p)),
    worktrees: brs.map((b) => b.worktreePath).filter((p): p is string => !!p),
  };
}

export function requestProjectDelete(ctx: Ctx, projectId: string, confirm: string) {
  ctx.store.require(projectId);
  if (confirm !== projectId) throw new BmError('CONFIRM', `Для удаления введите id проекта: ${projectId}`);
  return { jobId: getQueue().enqueue('delete_project', { projectId }, {}) };
}

export async function deleteProjectExecutor(ctx: Ctx, job: JobRow, jc: JobContext): Promise<void> {
  const cfg = ctx.store.require(job.projectId!);
  for (const b of ctx.db.select().from(builds).where(eq(builds.projectId, cfg.id)).all()) {
    if (b.status === 'dropped') continue;
    jc.log(`drop ${b.composeProject} #${b.number}`);
    await dropBuildResources(ctx, cfg, b, jc.log);
  }
  for (const br of ctx.db.select().from(branches).where(eq(branches.projectId, cfg.id)).all()) {
    if (br.worktreePath) {
      jc.log(`git worktree remove ${br.worktreePath}`);
      await removeWorktree(ctx, cfg, br, true).catch((e) => jc.log(`worktree: ${(e as Error).message}`));
    }
  }
  ctx.db.delete(builds).where(eq(builds.projectId, cfg.id)).run();
  ctx.db.delete(branches).where(eq(branches.projectId, cfg.id)).run();
  ctx.db.delete(projects).where(eq(projects.id, cfg.id)).run();
  ctx.store.deleteProject(cfg.id);
  audit(ctx, { projectId: cfg.id, action: 'project.delete', target: cfg.id });
  bus.emit({ type: 'project.changed', projectId: cfg.id });
}
