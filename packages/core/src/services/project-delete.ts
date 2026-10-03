import fs from 'node:fs';
import path from 'node:path';
import { and, eq, inArray, like, ne, or } from 'drizzle-orm';
import { BmError, isLegacyProject, type ProjectConfig, type ProjectDeletePreview } from '@bm/shared';
import { buildLogsDir, type Ctx } from '../context';
import { auditLog, branches, builds, jobs, kv, projects, snapshots, type JobRow } from '../db/schema';
import { getQueue, type JobContext } from '../jobs/queue';
import { dropBuildResources } from '../builds/drop';
import { removeWorktree } from '../git/worktrees';
import * as git from '../git';
import { ensureManagedPostgres, managedPgName, managedPgVolume, removeManagedPostgres } from '../docker/postgres';
import { removeProjectImage } from '../docker/image';
import { dbExists, dropDatabase } from '../pg';
import { assertOwned } from '../safety';
import { ownedRegistry } from '../registry';
import { audit } from './audit';
import { bus } from '../events';
import { invalidateGitCache } from './branches';
import { localWatcher } from './watch-local';
import { isInside, samePath, toPosix } from '../util/paths';
import { t } from '../i18n';

type Log = (line: string) => void;

const projectDir = (ctx: Ctx, id: string): string => toPosix(path.join(ctx.dataDir, 'projects', id));
const reposRoot = (ctx: Ctx): string => toPosix(path.join(ctx.dataDir, 'repos'));
const jobLogFile = (ctx: Ctx, j: Pick<JobRow, 'id' | 'type'>): string => path.join(ctx.logsDir, 'jobs', `${j.id}-${j.type}.log`);

/** Folders the app created for the project (D34): mirror, compose files, build logs, the project's worktrees folder. */
function ownFolders(ctx: Ctx, cfg: ProjectConfig): string[] {
  const list = [
    ...(cfg.repo.mirrorDir && isInside(reposRoot(ctx), cfg.repo.mirrorDir) ? [toPosix(cfg.repo.mirrorDir)] : []),
    projectDir(ctx, cfg.id),
    toPosix(buildLogsDir(ctx, cfg.id)),
    toPosix(path.join(cfg.repo.worktreesDir, cfg.id)),
  ];
  return list.filter((p) => fs.existsSync(p));
}

const kvKeys = (ctx: Ctx, id: string) =>
  ctx.db
    .select({ key: kv.key })
    .from(kv)
    .where(or(like(kv.key, `autoadd-skip:${id}:%`), eq(kv.key, `backup-seen:${id}`)))
    .all();

/** Everything the project owns (spec 8.1 «Удаление проекта», full cleanup D34). The user's repository is never touched. */
export function projectDeletePreview(ctx: Ctx, projectId: string): ProjectDeletePreview {
  const cfg = ctx.store.require(projectId);
  const rows = ctx.db.select().from(builds).where(eq(builds.projectId, projectId)).all().filter((b) => b.status !== 'dropped');
  const brs = ctx.db.select().from(branches).where(eq(branches.projectId, projectId)).all();
  return {
    legacy: isLegacyProject(cfg),
    builds: rows.map((b) => `${b.composeProject} #${b.number} (${b.status})`),
    databases: [...new Set(rows.map((b) => b.dbName))],
    filestores: [...new Set(rows.map((b) => toPosix(path.join(cfg.runtime.filestore.hostDir, b.dbName))))].filter((p) => fs.existsSync(p)),
    worktrees: brs.map((b) => b.worktreePath).filter((p): p is string => !!p),
    postgres: cfg.postgres.mode === 'managed' ? t('projectDelete.managedPg', { container: managedPgName(cfg.id), volume: managedPgVolume(cfg.id), network: cfg.runtime.network }) : null,
    image: cfg.runtime.build ? cfg.runtime.image : null,
    folders: ownFolders(ctx, cfg),
    settingsFile: toPosix(ctx.store.get(projectId)!.path),
    registry: {
      jobs: ctx.db.select({ id: jobs.id }).from(jobs).where(eq(jobs.projectId, projectId)).all().length,
      audit: ctx.db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.projectId, projectId)).all().length,
      kv: kvKeys(ctx, projectId).length,
    },
  };
}

export function requestProjectDelete(ctx: Ctx, projectId: string, confirm: string) {
  ctx.store.require(projectId);
  if (confirm !== projectId) throw new BmError('CONFIRM', t('projectDelete.confirm', { id: projectId }));
  return { jobId: getQueue().enqueue('delete_project', { projectId }, {}) };
}

/**
 * Databases and filestores of every build the registry knows (dropped ones too: a failed drop may have left them),
 * test copies and snapshots included. Only what `assertOwned` accepts is removed.
 */
async function dropLeftovers(ctx: Ctx, cfg: ProjectConfig, log: Log): Promise<void> {
  const reg = ownedRegistry(ctx, cfg.id);
  const all = ctx.db.select().from(builds).where(eq(builds.projectId, cfg.id)).all();
  const snaps = all.length ? ctx.db.select().from(snapshots).where(inArray(snapshots.buildId, all.map((b) => b.id))).all() : [];
  const dbs = new Set([...all.flatMap((b) => [b.dbName, `${b.dbName}_test`]), ...snaps.map((s) => s.dbName)]);
  for (const db of dbs) {
    try {
      if (!(await dbExists(cfg.postgres, db))) continue;
      assertOwned(cfg, { kind: 'db', name: db }, reg);
      log(`DROP DATABASE ${db}`);
      await dropDatabase(cfg.postgres, db);
    } catch (err) {
      log(t('projectDelete.dbError', { db, error: (err as Error).message }));
    }
  }
  for (const db of [...all.flatMap((b) => [b.dbName, `${b.dbName}_test`]), ...snaps.map((s) => s.dbName)]) {
    const dir = path.join(cfg.runtime.filestore.hostDir, db);
    if (!fs.existsSync(dir)) continue;
    try {
      assertOwned(cfg, { kind: 'filestore', path: dir, db }, reg);
      log(`rm filestore ${toPosix(dir)}`);
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      log(`filestore ${toPosix(dir)}: ${(err as Error).message}`);
    }
  }
}

/** Removes a folder the app created for the project; refuses anything outside the app's own places. */
async function removeOwnFolder(ctx: Ctx, cfg: ProjectConfig, dir: string, log: Log): Promise<void> {
  if (!fs.existsSync(dir)) return;
  for (const own of [cfg.repo.path, cfg.repo.localFolder]) {
    if (own && (samePath(dir, own) || isInside(dir, own) || isInside(own, dir))) throw new BmError('NOT_OWNED', t('projectDelete.ownRepo', { dir }));
  }
  if (cfg.repo.mirrorDir && samePath(dir, cfg.repo.mirrorDir)) {
    assertOwned(cfg, { kind: 'mirror', path: dir, reposRoot: reposRoot(ctx) }, ownedRegistry(ctx, cfg.id));
  } else if (samePath(dir, path.join(cfg.repo.worktreesDir, cfg.id))) {
    // Worktrees were removed one by one above; only an empty (or git-pruned) folder is expected here.
    const rest = fs.readdirSync(dir);
    if (rest.length) throw new BmError('NOT_EMPTY', t('projectDelete.notEmpty', { dir, rest: rest.join(', ') }));
  } else if (!isInside(ctx.dataDir, dir) && !isInside(ctx.logsDir, dir)) {
    throw new BmError('NOT_OWNED', t('projectDelete.outside', { dir }));
  }
  log(`rm ${toPosix(dir)}`);
  await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * Job `delete_project`: full cleanup (D34) — builds (containers, databases, filestores), snapshots, worktrees, the
 * app's Postgres, the mirror, the project folder with compose files, build and job logs, the settings file, registry
 * rows. The user's repository, its branches and foreign containers are never touched.
 */
export async function deleteProjectExecutor(ctx: Ctx, job: JobRow, jc: JobContext): Promise<void> {
  const cfg = ctx.store.require(job.projectId!);
  const settingsFile = ctx.store.get(cfg.id)!.path;
  await ensureManagedPostgres(ctx, cfg, jc.log).catch((e) => jc.log(`postgres: ${(e as Error).message}`));
  for (const b of ctx.db.select().from(builds).where(eq(builds.projectId, cfg.id)).all()) {
    if (b.status === 'dropped') continue;
    jc.log(`drop ${b.composeProject} #${b.number}`);
    await dropBuildResources(ctx, cfg, b, jc.log);
  }
  await dropLeftovers(ctx, cfg, jc.log);
  for (const br of ctx.db.select().from(branches).where(eq(branches.projectId, cfg.id)).all()) {
    if (br.worktreePath) {
      jc.log(`git worktree remove ${br.worktreePath}`);
      await removeWorktree(ctx, cfg, br, true).catch((e) => jc.log(`worktree: ${(e as Error).message}`));
    }
  }
  // Legacy project: worktree metadata in the user's repository (`.git/worktrees`) is pruned; nothing else there changes.
  if (cfg.repo.path && fs.existsSync(cfg.repo.path)) await git.worktreePrune(cfg.repo.path);
  // The app's own Postgres goes last: dropping databases above still needs it.
  await removeManagedPostgres(ctx, cfg, jc.log);
  // The Odoo image the app built for the project (runtime.build, D46): only with its bm.project label.
  await removeProjectImage(cfg, jc.log);

  for (const dir of ownFolders(ctx, cfg)) {
    await removeOwnFolder(ctx, cfg, dir, jc.log).catch((e) => jc.log(t('projectDelete.folderError', { error: (e as Error).message })));
  }
  const otherJobs = ctx.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.projectId, cfg.id), ne(jobs.id, job.id)))
    .all();
  for (const j of otherJobs) fs.rmSync(jobLogFile(ctx, j), { force: true });
  jc.log(t('projectDelete.jobLogs', { n: otherJobs.length }));

  const buildIds = ctx.db.select({ id: builds.id }).from(builds).where(eq(builds.projectId, cfg.id)).all().map((b) => b.id);
  if (buildIds.length) ctx.db.delete(snapshots).where(inArray(snapshots.buildId, buildIds)).run();
  // Monitor and lifecycle traces of the builds (D45).
  for (const id of buildIds) {
    ctx.sqlite.prepare('DELETE FROM http_stats WHERE build_id = ?').run(id);
    ctx.sqlite.prepare('DELETE FROM resource_stats WHERE build_id = ?').run(id);
    ctx.sqlite.prepare('DELETE FROM kv WHERE key = ?').run(`drop-warned:${id}`);
  }
  ctx.db.delete(builds).where(eq(builds.projectId, cfg.id)).run();
  ctx.db.delete(branches).where(eq(branches.projectId, cfg.id)).run();
  ctx.db.delete(projects).where(eq(projects.id, cfg.id)).run();
  ctx.db.delete(jobs).where(and(eq(jobs.projectId, cfg.id), ne(jobs.id, job.id))).run();
  ctx.db.delete(auditLog).where(eq(auditLog.projectId, cfg.id)).run();
  ctx.db.delete(kv).where(or(like(kv.key, `autoadd-skip:${cfg.id}:%`), eq(kv.key, `backup-seen:${cfg.id}`))).run();
  jc.log(`rm ${toPosix(settingsFile)}`);
  ctx.store.deleteProject(cfg.id);
  invalidateGitCache(cfg.id);
  await localWatcher()?.sync();
  // One trace of the deletion stays in Audit Logs.
  audit(ctx, { projectId: cfg.id, action: 'project.delete', target: cfg.id, params: { legacy: isLegacyProject(cfg) } });
  bus.emit({ type: 'project.changed', projectId: cfg.id });
}
