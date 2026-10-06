import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { BmError, locale, type ProjectConfig, type SnapshotView } from '@bm/shared';
import type { Ctx } from '../context';
import { builds, snapshots, type BuildRow, type JobRow, type SnapshotRow } from '../db/schema';
import { getQueue, type JobContext, type JobQueue } from '../jobs/queue';
import { docker } from '../docker/client';
import { ensurePostgres } from '../docker/postgres';
import { refreshContainers } from '../docker/watch';
import { buildContainers } from '../builds/drop';
import { liveCompose } from '../builds/executors';
import { assertOdooOk, dbSubcommand, runOdooOneOff } from '../builds/odoo-cli';
import { liveBuild } from '../builds/view';
import { assertSqlIdent } from '../config/templates';
import * as pg from '../pg';
import { assertOwned } from '../safety';
import { ownedRegistry } from '../registry';
import { copyTree, treeSize } from '../util/fs-tree';
import { toPosix } from '../util/paths';
import { nowIso } from '../util/time';
import { branchRow } from './branch-rows';
import { audit } from './audit';
import { bus } from '../events';
import { t } from '../i18n';

/**
 * Snapshots (spec 8.9 Backups, D42): `CREATE DATABASE <db>_snap_<n> TEMPLATE <db>` + a hardlink copy of the filestore
 * to `<filestore>/<db>_snap_<n>`. They belong to the database, not to one build: an `update` chain shares its database,
 * so the snapshots of the live build are those named after its database.
 */

const SNAP_RE = /_snap_(\d+)$/;
/** Postgres truncates identifiers longer than 63 bytes. */
const PG_NAME_MAX = 63;

function mustLive(ctx: Ctx, branchId: number): BuildRow {
  const br = branchRow(ctx, branchId);
  if (!br) throw new BmError('NO_BRANCH', t('config.noBranch'));
  const live = liveBuild(ctx, branchId);
  if (!live) throw new BmError('NO_LIVE', t('snap.noLive', { branch: br.name }));
  return live;
}

/** Snapshot rows of a database (all builds of the project that used it). */
function snapshotsOf(ctx: Ctx, projectId: string, dbName: string): SnapshotRow[] {
  const ids = ctx.db.select({ id: builds.id }).from(builds).where(and(eq(builds.projectId, projectId), eq(builds.dbName, dbName))).all().map((r) => r.id);
  if (!ids.length) return [];
  return ctx.db
    .select()
    .from(snapshots)
    .where(inArray(snapshots.buildId, ids))
    .orderBy(desc(snapshots.id))
    .all()
    .filter((s) => s.dbName.startsWith(`${dbName}_snap_`));
}

const view = (s: SnapshotRow): SnapshotView => ({ id: s.id, name: s.name, dbName: s.dbName, sizeBytes: s.sizeBytes, createdAt: s.createdAt });

export function listSnapshots(ctx: Ctx, branchId: number): SnapshotView[] {
  const live = liveBuild(ctx, branchId);
  return live ? snapshotsOf(ctx, live.projectId, live.dbName).map(view) : [];
}

function mustSnapshot(ctx: Ctx, id: number): { s: SnapshotRow; live: BuildRow } {
  const s = ctx.db.select().from(snapshots).where(eq(snapshots.id, id)).get();
  if (!s) throw new BmError('NO_SNAPSHOT', t('snap.notFound'));
  const owner = ctx.db.select().from(builds).where(eq(builds.id, s.buildId)).get();
  const live = owner ? liveBuild(ctx, owner.branchId) : undefined;
  if (!live || s.dbName.replace(SNAP_RE, '') !== live.dbName) {
    throw new BmError('SNAPSHOT_STALE', t('snap.stale'));
  }
  return { s, live };
}

/** The next free `<db>_snap_<n>`: after the known rows and the databases that exist. */
async function nextSnapshotName(ctx: Ctx, cfg: ProjectConfig, db: string): Promise<string> {
  const used = snapshotsOf(ctx, cfg.id, db).map((s) => Number(SNAP_RE.exec(s.dbName)?.[1] ?? 0));
  for (let n = Math.max(0, ...used) + 1; ; n++) {
    const name = `${db}_snap_${n}`;
    if (Buffer.byteLength(name) > PG_NAME_MAX) {
      throw new BmError('NAME_TOO_LONG', t('snap.nameTooLong', { name, max: PG_NAME_MAX }));
    }
    assertSqlIdent(name);
    if (!(await pg.dbExists(cfg.postgres, name))) return name;
  }
}

function insertRow(ctx: Ctx, buildId: number, name: string, dbName: string, cfg: ProjectConfig): SnapshotRow {
  return ctx.db
    .insert(snapshots)
    .values({ buildId, name, dbName, filestorePath: toPosix(path.join(cfg.runtime.filestore.hostDir, dbName)), sizeBytes: null, createdAt: nowIso() })
    .returning()
    .get();
}

async function sizeOf(cfg: ProjectConfig, db: string): Promise<number | null> {
  const d = await pg.dbSize(cfg.postgres, db);
  return d === null ? null : d + (await treeSize(path.join(cfg.runtime.filestore.hostDir, db)));
}

/** Removes a database and its filestore folder (both through assertOwned). */
async function removeDbAndFiles(ctx: Ctx, cfg: ProjectConfig, db: string, log: (l: string) => void): Promise<void> {
  const reg = ownedRegistry(ctx, cfg.id);
  if (await pg.dbExists(cfg.postgres, db)) {
    assertOwned(cfg, { kind: 'db', name: db }, reg);
    log(`DROP DATABASE ${db}`);
    await pg.dropDatabase(cfg.postgres, db);
  }
  const dir = path.join(cfg.runtime.filestore.hostDir, db);
  if (fs.existsSync(dir)) {
    assertOwned(cfg, { kind: 'filestore', path: dir, db }, reg);
    log(`rm filestore ${toPosix(dir)}`);
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** Stops the build's service container for `fn` (open connections block TEMPLATE / RENAME) and starts it again. */
async function withStopped<T>(ctx: Ctx, cfg: ProjectConfig, b: BuildRow, log: (l: string) => void, fn: () => Promise<T>): Promise<T> {
  const c = (await buildContainers(b)).find((x) => !x.oneoff && x.state === 'running');
  if (c) {
    assertOwned(cfg, { kind: 'container', name: c.name, labels: c.labels }, ownedRegistry(ctx, cfg.id));
    log(`stop ${c.name}`);
    await docker.getContainer(c.id).stop({ t: 20 }).catch(() => {});
  }
  try {
    return await fn();
  } finally {
    if (c) {
      log(`start ${c.name}`);
      await docker.getContainer(c.id).start().catch((e) => log(t('snap.startFailed', { name: c.name, error: (e as Error).message })));
      await refreshContainers(ctx).catch(() => {});
    }
  }
}

const changed = (ctx: Ctx, b: BuildRow): void => bus.emit({ type: 'build.changed', projectId: b.projectId, branchId: b.branchId, buildId: b.id });

/** Copies the database and the filestore of `src` to `dst` (a new snapshot, or the live database back from one). */
async function copyDbAndFiles(cfg: ProjectConfig, src: string, dst: string, log: (l: string) => void): Promise<void> {
  log(`CREATE DATABASE "${dst}" TEMPLATE "${src}"`);
  await pg.createFromTemplate(cfg.postgres, dst, src);
  const from = path.join(cfg.runtime.filestore.hostDir, src);
  const to = path.join(cfg.runtime.filestore.hostDir, dst);
  if (fs.existsSync(from)) {
    const r = await copyTree(from, to, cfg.runtime.filestore.copy, log);
    log(t('snap.filestore', { n: r.files, how: t(r.linked ? 'snap.hardlinks' : 'snap.copying') }));
  } else await fs.promises.mkdir(to, { recursive: true });
}

/** Job `snapshot`: the build's container is stopped only while the database and the filestore are copied. */
async function createExecutor(ctx: Ctx, job: JobRow, jc: JobContext): Promise<void> {
  const b = ctx.db.select().from(builds).where(eq(builds.id, job.buildId!)).get();
  if (!b) throw new BmError('NO_BUILD', t('common.noBuild'));
  const cfg = ctx.store.require(b.projectId);
  await ensurePostgres(ctx, cfg, jc.log);
  const dbName = await nextSnapshotName(ctx, cfg, b.dbName);
  const label = (job.params.name as string | undefined)?.trim() || t('snap.defaultName', { date: new Date().toLocaleString(locale()) });
  // The row goes first: the registry then owns the new database, and a failure can clean it up (assertOwned).
  const row = insertRow(ctx, b.id, label, dbName, cfg);
  try {
    await withStopped(ctx, cfg, b, jc.log, () => copyDbAndFiles(cfg, b.dbName, dbName, jc.log));
  } catch (err) {
    await removeDbAndFiles(ctx, cfg, dbName, jc.log).catch((e) => jc.log(`[warn] ${(e as Error).message}`));
    ctx.db.delete(snapshots).where(eq(snapshots.id, row.id)).run();
    throw err;
  }
  ctx.db.update(snapshots).set({ sizeBytes: await sizeOf(cfg, dbName) }).where(eq(snapshots.id, row.id)).run();
  audit(ctx, { projectId: cfg.id, action: 'snapshot.create', target: dbName, params: { name: label, build: `${b.composeProject}#${b.number}` } });
  changed(ctx, b);
}

/**
 * Job `restore_snapshot`: the live database is renamed to a new snapshot «перед откатом» (nothing is lost, and a
 * failed copy is rolled back by renaming it back), then recreated from the chosen snapshot; the same for the filestore.
 */
async function restoreExecutor(ctx: Ctx, job: JobRow, jc: JobContext): Promise<void> {
  const { s, live } = mustSnapshot(ctx, job.params.snapshotId as number);
  const cfg = ctx.store.require(live.projectId);
  await ensurePostgres(ctx, cfg, jc.log);
  const reg = () => ownedRegistry(ctx, cfg.id);
  const keep = await nextSnapshotName(ctx, cfg, live.dbName);
  const keepRow = insertRow(ctx, live.id, t('snap.beforeRestore', { name: s.name }), keep, cfg);
  const dir = (db: string) => path.join(cfg.runtime.filestore.hostDir, db);
  await withStopped(ctx, cfg, live, jc.log, async () => {
    assertOwned(cfg, { kind: 'db', name: live.dbName }, reg());
    assertOwned(cfg, { kind: 'db', name: keep }, reg());
    jc.log(`ALTER DATABASE ${live.dbName} RENAME TO ${keep}`);
    await pg.renameDatabase(cfg.postgres, live.dbName, keep);
    const hadFiles = fs.existsSync(dir(live.dbName));
    if (hadFiles) {
      assertOwned(cfg, { kind: 'filestore', path: dir(live.dbName), db: live.dbName }, reg());
      await fs.promises.rename(dir(live.dbName), dir(keep));
    }
    try {
      await copyDbAndFiles(cfg, s.dbName, live.dbName, jc.log);
    } catch (err) {
      jc.log(t('snap.restoreFailed', { error: (err as Error).message }));
      await removeDbAndFiles(ctx, cfg, live.dbName, jc.log).catch(() => {});
      await pg.renameDatabase(cfg.postgres, keep, live.dbName);
      if (hadFiles) await fs.promises.rename(dir(keep), dir(live.dbName));
      ctx.db.delete(snapshots).where(eq(snapshots.id, keepRow.id)).run();
      throw err;
    }
  });
  ctx.db.update(snapshots).set({ sizeBytes: await sizeOf(cfg, keep) }).where(eq(snapshots.id, keepRow.id)).run();
  // The database is now that of the snapshot: what code it got and what its tests showed is no longer known (D76).
  ctx.db.update(builds).set({ codeState: null, testedCode: null }).where(eq(builds.id, live.id)).run();
  audit(ctx, { projectId: cfg.id, action: 'snapshot.restore', target: s.dbName, params: { name: s.name, db: live.dbName, before: keep } });
  changed(ctx, live);
}

async function deleteExecutor(ctx: Ctx, job: JobRow, jc: JobContext): Promise<void> {
  const s = ctx.db.select().from(snapshots).where(eq(snapshots.id, job.params.snapshotId as number)).get();
  if (!s) return;
  const b = ctx.db.select().from(builds).where(eq(builds.id, s.buildId)).get();
  if (!b) throw new BmError('NO_BUILD', t('snap.noBuild'));
  const cfg = ctx.store.require(b.projectId);
  await ensurePostgres(ctx, cfg, jc.log);
  await removeDbAndFiles(ctx, cfg, s.dbName, jc.log);
  ctx.db.delete(snapshots).where(eq(snapshots.id, s.id)).run();
  audit(ctx, { projectId: cfg.id, action: 'snapshot.delete', target: s.dbName, params: { name: s.name } });
  changed(ctx, b);
}

/**
 * Job `export_db`: `odoo db dump` (Odoo backup .zip with the filestore) of the live database or a snapshot. Odoo
 * writes into the app's own folder `<dataDir>/exports`; the file is then moved to the chosen path, so the container
 * never gets a mount of the user's folders.
 */
async function exportExecutor(ctx: Ctx, job: JobRow, jc: JobContext): Promise<void> {
  const live = ctx.db.select().from(builds).where(eq(builds.id, job.buildId!)).get();
  if (!live) throw new BmError('NO_BUILD', t('common.noBuild'));
  const cfg = ctx.store.require(live.projectId);
  const snapId = job.params.snapshotId as number | null;
  const db = snapId ? mustSnapshot(ctx, snapId).s.dbName : live.dbName;
  const target = job.params.path as string;
  await ensurePostgres(ctx, cfg, jc.log);
  const tmpDir = path.join(ctx.dataDir, 'exports');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpName = `${db}-${crypto.randomBytes(3).toString('hex')}.zip`;
  const tmp = path.join(tmpDir, tmpName);
  try {
    const { cmd, env } = dbSubcommand(cfg, ['dump', db, `/bm-out/${tmpName}`]);
    const r = await runOdooOneOff({ composeFile: liveCompose(ctx, live), project: live.composeProject, cmd, env, volumes: [`${toPosix(tmpDir)}:/bm-out`], log: jc.log, signal: jc.signal });
    assertOdooOk(r, t('snap.dumpWhat'));
    if (!fs.existsSync(tmp)) throw new BmError('EXPORT_FAILED', t('snap.dumpNoFile'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await fs.promises.copyFile(tmp, target);
    jc.log(t('snap.saved', { file: target, size: fs.statSync(target).size }));
  } finally {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
  }
  audit(ctx, { projectId: cfg.id, action: 'snapshot.export', target: db, params: { path: target } });
}

export function registerSnapshotExecutors(q: JobQueue): void {
  q.register('snapshot', createExecutor);
  q.register('restore_snapshot', restoreExecutor);
  q.register('delete_snapshot', deleteExecutor);
  q.register('export_db', exportExecutor);
}

export function snapshotHandlers(ctx: Ctx) {
  const enqueue = (type: 'snapshot' | 'restore_snapshot' | 'delete_snapshot' | 'export_db', b: BuildRow, params: Record<string, unknown>) => ({
    jobId: getQueue().enqueue(type, { projectId: b.projectId, branchId: b.branchId, buildId: b.id }, params),
  });
  return {
    'snapshots.list': (p: { branchId: number }) => listSnapshots(ctx, p.branchId),
    'snapshots.create': (p: { branchId: number; name?: string }) => enqueue('snapshot', mustLive(ctx, p.branchId), { name: p.name ?? null }),
    'snapshots.restore': (p: { snapshotId: number }) => {
      const { live } = mustSnapshot(ctx, p.snapshotId);
      return enqueue('restore_snapshot', live, { snapshotId: p.snapshotId });
    },
    'snapshots.delete': (p: { snapshotId: number }) => {
      const s = ctx.db.select().from(snapshots).where(eq(snapshots.id, p.snapshotId)).get();
      const b = s ? ctx.db.select().from(builds).where(eq(builds.id, s.buildId)).get() : undefined;
      if (!s || !b) throw new BmError('NO_SNAPSHOT', t('snap.notFound'));
      return enqueue('delete_snapshot', b, { snapshotId: s.id });
    },
    'snapshots.export': (p: { branchId: number; snapshotId?: number; path: string }) => {
      if (!path.isAbsolute(p.path)) throw new BmError('BAD_PATH', t('snap.fullPath'));
      const live = mustLive(ctx, p.branchId);
      if (p.snapshotId) mustSnapshot(ctx, p.snapshotId);
      return enqueue('export_db', live, { snapshotId: p.snapshotId ?? null, path: p.path });
    },
  };
}
