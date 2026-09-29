import YAML from 'yaml';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { BmError, isLegacyProject, type PgMigratePreview, type ProjectConfig } from '@bm/shared';
import type { Ctx } from '../context';
import { builds, jobs, snapshots, type BuildRow, type JobRow } from '../db/schema';
import { getQueue, type JobContext } from '../jobs/queue';
import { dockerCli } from '../docker/client';
import {
  allocatePgPort,
  ensureManagedPostgres,
  ensurePostgres,
  externalPgContainer,
  managedPgName,
  removeManagedPostgres,
  type ExternalPgContainer,
} from '../docker/postgres';
import { ensureTraefik } from '../docker/traefik';
import { refreshContainers } from '../docker/watch';
import { buildContainers } from '../builds/drop';
import { compose, writeLiveCompose } from '../builds/executors';
import { createEmpty, dbFingerprint, dbSize, dropDatabase, listDatabases, pgPing, query } from '../pg';
import { runtimeState } from '../state';
import { audit } from './audit';
import { onProjectConfigChanged } from './projects';

/**
 * «Перевести на свой Postgres»: a project on an external Postgres (usually `db` of the user's own compose stack) moves
 * to the app's container `bm-<project>-db` (D30) in its own network `bm-<project>`, so stopping or removing the user's
 * stack no longer breaks the branches. The databases of the builds are copied; the source ones are left untouched.
 */

const targetNetwork = (cfg: ProjectConfig): string => `bm-${cfg.id}`;

/** From inside a container the Postgres published on this machine is reached through host.docker.internal. */
const hostFromDocker = (host: string): string => (['localhost', '127.0.0.1', '::1'].includes(host) ? 'host.docker.internal' : host);

/** Databases of the project's builds: live and old ones, their test copies and snapshots. */
function projectDatabases(ctx: Ctx, projectId: string): string[] {
  const rows = ctx.db.select().from(builds).where(eq(builds.projectId, projectId)).all().filter((b) => b.status !== 'dropped');
  const snaps = rows.length ? ctx.db.select().from(snapshots).where(inArray(snapshots.buildId, rows.map((b) => b.id))).all() : [];
  return [...new Set([...rows.flatMap((b) => [b.dbName, `${b.dbName}_test`]), ...snaps.map((s) => s.dbName)])].sort();
}

const liveBuilds = (ctx: Ctx, projectId: string): BuildRow[] =>
  ctx.db
    .select()
    .from(builds)
    .where(eq(builds.projectId, projectId))
    .all()
    .filter((b) => b.live && (b.status === 'running' || b.status === 'stopped'));

/** The image of the user's Postgres container (extensions such as pgvector come with it), else the official one. */
async function targetImage(cfg: ProjectConfig, container: ExternalPgContainer | null, version: string, dbs: string[]): Promise<string> {
  if (container) return container.image;
  const major = version.split(/[.\s]/)[0] || '16';
  for (const db of dbs) {
    const rows = await query<{ n: number }>(cfg.postgres, db, "SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'vector'").catch(() => []);
    if (rows[0]?.n) return `pgvector/pgvector:pg${major}`;
  }
  return `postgres:${major}`;
}

function blocker(ctx: Ctx, cfg: ProjectConfig, selfJobId = 0): string | null {
  if (cfg.postgres.mode !== 'external') return 'Проект уже работает на своём Postgres приложения.';
  if (isLegacyProject(cfg)) return 'Проект старой схемы: удалите его и добавьте заново.';
  if (!cfg.postgres.password) return 'Не задан пароль Postgres (Settings → Postgres).';
  if (!runtimeState.docker.ok) return 'Docker недоступен: запустите Docker Desktop.';
  const active = ctx.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.projectId, cfg.id), eq(jobs.type, 'migrate_postgres'), inArray(jobs.status, ['queued', 'running']), ne(jobs.id, selfJobId)))
    .get();
  if (active) return `Перевод уже идёт (задача ${active.id}).`;
  return null;
}

export async function pgMigratePreview(ctx: Ctx, projectId: string): Promise<PgMigratePreview> {
  const cfg = ctx.store.require(projectId);
  const pg = cfg.postgres;
  const container = runtimeState.docker.ok ? await externalPgContainer(cfg) : null;
  let version: string | null = null;
  let error: string | null = null;
  try {
    version = await pgPing(pg);
  } catch (err) {
    error = (err as Error).message;
  }
  const existing = version ? new Set(await listDatabases(pg).catch(() => [])) : null;
  const names = projectDatabases(ctx, projectId).filter((d) => !existing || existing.has(d));
  const databases = await Promise.all(names.map(async (name) => ({ name, sizeBytes: version ? await dbSize(pg, name) : null })));
  const image = version ? await targetImage(cfg, container, version, names) : (container?.image ?? pg.image);
  let b = blocker(ctx, cfg);
  if (!b && !version && !container) b = `Postgres ${pg.host}:${pg.port} недоступен, а его контейнер не найден: ${error}`;
  return {
    blocker: b,
    source: { host: pg.host, port: pg.port, container: container?.name ?? null, version, error },
    target: { container: managedPgName(cfg.id), image, port: await allocatePgPort(ctx).catch(() => null), network: targetNetwork(cfg) },
    databases,
    builds: liveBuilds(ctx, projectId).map((x) => `${x.composeProject} #${x.number}`),
  };
}

export function requestPgMigrate(ctx: Ctx, projectId: string): { jobId: number } {
  const cfg = ctx.store.require(projectId);
  const b = blocker(ctx, cfg);
  if (b) throw new BmError('BAD_STATE', b);
  return { jobId: getQueue().enqueue('migrate_postgres', { projectId }) };
}

/** pg_dump from the external Postgres and pg_restore, both run inside the new container (its client matches the server). */
async function copyDatabase(src: ProjectConfig['postgres'], dst: ProjectConfig['postgres'], container: string, db: string, jc: JobContext): Promise<void> {
  const file = `/tmp/bm-migrate-${db}.dump`;
  const sh = (script: string, args: string[]) =>
    dockerCli(['exec', container, 'sh', '-c', script, 'sh', ...args], { signal: jc.signal, timeoutMs: 6 * 3600_000 });
  const tail = (r: { stdout: string; stderr: string }) => (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ');
  const t0 = Date.now();
  jc.log(`${db}: pg_dump`);
  // The password comes from the container's own environment: it never appears in a command line.
  const dump = await sh('PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h "$1" -p "$2" -U "$POSTGRES_USER" -Fc -Z1 -f "$4" "$3"', [
    hostFromDocker(src.host),
    String(src.port),
    db,
    file,
  ]);
  if (dump.exitCode !== 0) {
    await sh('rm -f "$1"', [file]);
    throw new BmError('PG_DUMP', `pg_dump ${db}: ${tail(dump)}`);
  }
  jc.log(`${db}: pg_restore`);
  // The target is the app's fresh container: a database left by an earlier failed attempt is replaced.
  await dropDatabase(dst, db);
  await createEmpty(dst, db);
  const restore = await sh('pg_restore -U "$POSTGRES_USER" -d "$1" --no-owner --no-acl --exit-on-error -j 4 "$2"; s=$?; rm -f "$2"; exit $s', [db, file]);
  if (restore.exitCode !== 0) throw new BmError('PG_RESTORE', `pg_restore ${db}: ${tail(restore)}`);
  const a = await dbFingerprint(src, db);
  const b = await dbFingerprint(dst, db);
  if (a.tables !== b.tables) throw new BmError('PG_VERIFY', `${db}: таблиц ${a.tables} в исходной БД и ${b.tables} в копии`);
  if (a.modules !== b.modules) throw new BmError('PG_VERIFY', `${db}: установленных модулей ${a.modules} в исходной БД и ${b.modules} в копии`);
  jc.log(`${db}: скопирована за ${Math.round((Date.now() - t0) / 1000)} с`);
}

/** Job `migrate_postgres` (runs alone in its project: see EXCLUSIVE in the queue). */
export async function pgMigrateExecutor(ctx: Ctx, job: JobRow, jc: JobContext): Promise<void> {
  const cfg = ctx.store.require(job.projectId!);
  const b = blocker(ctx, cfg, job.id);
  if (b) throw new BmError('BAD_STATE', b);
  const src = cfg.postgres;
  await ensurePostgres(ctx, cfg, jc.log);
  const version = await pgPing(src);
  const existing = new Set(await listDatabases(src));
  const dbs = projectDatabases(ctx, cfg.id).filter((d) => existing.has(d));
  const image = await targetImage(cfg, await externalPgContainer(cfg), version, dbs);
  const port = await allocatePgPort(ctx);
  const network = targetNetwork(cfg);
  const name = managedPgName(cfg.id);
  const target: ProjectConfig = {
    ...cfg,
    postgres: { ...src, mode: 'managed', image, port, protectedContainers: [...new Set([...src.protectedContainers, name])] },
    runtime: { ...cfg.runtime, network },
  };
  jc.log(`Источник: ${src.host}:${src.port}, PostgreSQL ${version}; баз для копирования: ${dbs.length}`);
  jc.log(`Свой Postgres: ${name} (${image}), 127.0.0.1:${port}, сеть ${network}`);

  const live = liveBuilds(ctx, cfg.id);
  const running: BuildRow[] = [];
  let switched = false;
  try {
    await ensureManagedPostgres(ctx, target, jc.log);
    const dstVersion = await pgPing(target.postgres);
    if (parseInt(dstVersion, 10) < parseInt(version, 10)) {
      throw new BmError('PG_VERSION', `PostgreSQL ${dstVersion} в ${name} старше источника ${version}: укажите образ не ниже`);
    }
    // Odoo writes to its database: live builds are stopped so each copy is consistent.
    for (const x of live) {
      const cs = await buildContainers(x.id);
      if (!cs.some((c) => !c.oneoff && (c.state === 'running' || c.state === 'restarting'))) continue;
      running.push(x);
      jc.log(`docker compose stop ${x.composeProject}`);
      await compose(ctx, x, ['stop'], jc);
    }
    for (const [i, db] of dbs.entries()) {
      jc.log(`[${i + 1}/${dbs.length}] ${db}`);
      await copyDatabase(src, target.postgres, name, db, jc);
    }

    const e = ctx.store.get(cfg.id)!;
    const doc = YAML.parseDocument(e.text);
    doc.setIn(['postgres', 'mode'], 'managed');
    doc.setIn(['postgres', 'image'], image);
    doc.setIn(['postgres', 'port'], port);
    doc.setIn(['postgres', 'protectedContainers'], target.postgres.protectedContainers);
    doc.setIn(['runtime', 'network'], network);
    const next = ctx.store.putProject(doc.toString(), { expectId: cfg.id });
    switched = true;
    onProjectConfigChanged(ctx, cfg, next);
    jc.log(`Настройки проекта: postgres.mode managed, порт ${port}, сеть ${network}`);
  } catch (err) {
    if (switched) throw err;
    // A cancelled job still rolls back: the steps below must not see its aborted signal.
    const calm: JobContext = { ...jc, signal: new AbortController().signal };
    jc.log(`Откат: ${(err as Error).message}`);
    await removeManagedPostgres(ctx, target, jc.log).catch((e) => jc.log(`${name}: ${(e as Error).message}`));
    for (const x of running) await compose(ctx, x, ['start'], calm).catch((e) => jc.log(`${x.composeProject}: ${(e as Error).message}`));
    throw err;
  }

  await ensureTraefik(ctx);
  const failed: string[] = [];
  for (const x of live) {
    try {
      const hash = writeLiveCompose(ctx, x);
      const start = running.includes(x);
      jc.log(`${x.composeProject}: пересоздание в сети ${network}${start ? '' : ' (без запуска)'}`);
      await compose(ctx, x, start ? ['up', '-d', '--remove-orphans'] : ['up', '--no-start', '--remove-orphans'], jc);
      ctx.db.update(builds).set({ configHash: hash }).where(eq(builds.id, x.id)).run();
    } catch (err) {
      failed.push(x.composeProject);
      jc.log(`${x.composeProject}: ${(err as Error).message}`);
    }
  }
  await refreshContainers(ctx).catch(() => {});
  audit(ctx, { projectId: cfg.id, action: 'project.pgMigrate', target: name, params: { image, port, network, databases: dbs } });
  const source = (await externalPgContainer(cfg))?.name ?? `${src.host}:${src.port}`;
  jc.log(`Готово. Базы в прежнем Postgres (${source}) не тронуты — удалите их вручную, когда убедитесь, что ветки работают.`);
  if (failed.length) throw new BmError('COMPOSE', `Базы перенесены, но не пересоздались сборки: ${failed.join(', ')}. Нажмите у них «Применить».`);
}
