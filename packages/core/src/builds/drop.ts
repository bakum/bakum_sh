import fs from 'node:fs';
import path from 'node:path';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { ProjectConfig } from '@bm/shared';
import { branchDir, type Ctx } from '../context';
import { branchRow } from '../services/branch-rows';
import { builds, snapshots, type BuildRow } from '../db/schema';
import { docker, dockerCli } from '../docker/client';
import { assertOwned } from '../safety';
import { ownedRegistry } from '../registry';
import { dbExists, dropDatabase } from '../pg';
import { bus } from '../events';
import { audit } from '../services/audit';
import { containerStates } from '../docker/state';
import { nowIso } from '../util/time';

type Log = (line: string) => void;

/** Containers (service and one-off) labelled with this build. */
export async function buildContainers(buildId: number): Promise<{ id: string; name: string; labels: Record<string, string>; state: string; oneoff: boolean }[]> {
  const list = await docker.listContainers({ all: true, filters: { label: [`bm.build=${buildId}`] } });
  return list.map((c) => ({
    id: c.Id,
    name: (c.Names[0] ?? '').replace(/^\//, ''),
    labels: c.Labels,
    state: c.State,
    // Compose one-offs of the steps and `docker run` containers of the Postgres tools (bm.oneoff).
    oneoff: c.Labels['com.docker.compose.oneoff'] === 'True' || c.Labels['bm.oneoff'] === 'true',
  }));
}

/**
 * «Отбросить» / DROPPED (spec 2, 8.3): removes what the build created — its container (only if it is this
 * build's), its database (unless another non-dropped build still uses it after `update`), its filestore.
 * Everything goes through assertOwned. Idempotent.
 */
export async function dropBuildResources(ctx: Ctx, cfg: ProjectConfig, b: BuildRow, log: Log): Promise<void> {
  const reg = ownedRegistry(ctx, cfg.id);
  // 1. Containers of this build (service container if it serves this build, leftover one-off containers).
  for (const c of await buildContainers(b.id)) {
    assertOwned(cfg, { kind: 'container', name: c.name, labels: c.labels }, reg);
    if (!c.oneoff) {
      assertOwned(cfg, { kind: 'compose', name: b.composeProject }, reg);
      log(`docker compose -p ${b.composeProject} down -v`);
      const br = branchRow(ctx, b.branchId);
      const composeFile = br ? path.join(branchDir(ctx, cfg.id, br.slug), 'compose.yml') : '';
      const args = ['compose', '-p', b.composeProject];
      if (composeFile && fs.existsSync(composeFile)) args.push('-f', composeFile);
      const r = await dockerCli([...args, 'down', '-v', '--remove-orphans', '--timeout', '20'], { onLine: log });
      if (r.exitCode !== 0) {
        log(`compose down failed, removing container ${c.name}`);
        await docker.getContainer(c.id).remove({ force: true, v: true }).catch(() => {});
      }
      containerStates.delete(b.composeProject);
    } else {
      log(`remove one-off container ${c.name}`);
      await docker.getContainer(c.id).remove({ force: true, v: true }).catch(() => {});
    }
  }
  // 2. Database (shared by an `update` chain: drop only when no other live/failed build keeps it).
  const sharing = ctx.db
    .select()
    .from(builds)
    .where(and(eq(builds.dbName, b.dbName), ne(builds.id, b.id), ne(builds.status, 'dropped')))
    .all();
  if (sharing.length) {
    log(`БД ${b.dbName} используется сборками ${sharing.map((s) => `#${s.number}`).join(', ')} — не удаляется`);
  } else {
    for (const db of [b.dbName, `${b.dbName}_test`]) {
      if (await dbExists(cfg.postgres, db).catch(() => false)) {
        assertOwned(cfg, { kind: 'db', name: db }, reg);
        log(`DROP DATABASE ${db}`);
        await dropDatabase(cfg.postgres, db);
      }
    }
    // 3. Snapshots of the database (D42): they belong to the database and go with it.
    const ids = ctx.db.select({ id: builds.id }).from(builds).where(and(eq(builds.projectId, b.projectId), eq(builds.dbName, b.dbName))).all().map((x) => x.id);
    const snaps = ctx.db.select().from(snapshots).where(inArray(snapshots.buildId, ids)).all().filter((s) => s.dbName.startsWith(`${b.dbName}_snap_`));
    for (const s of snaps) {
      if (await dbExists(cfg.postgres, s.dbName).catch(() => false)) {
        assertOwned(cfg, { kind: 'db', name: s.dbName }, reg);
        log(`DROP DATABASE ${s.dbName} (снапшот «${s.name}»)`);
        await dropDatabase(cfg.postgres, s.dbName);
      }
    }
    // 4. Filestore of the database, of its test copy (left by an interrupted tests step) and of its snapshots.
    for (const db of [b.dbName, `${b.dbName}_test`, ...snaps.map((s) => s.dbName)]) {
      const fsDir = path.join(cfg.runtime.filestore.hostDir, db);
      if (!fs.existsSync(fsDir)) continue;
      assertOwned(cfg, { kind: 'filestore', path: fsDir, db }, reg);
      log(`rm filestore ${fsDir}`);
      await fs.promises.rm(fsDir, { recursive: true, force: true, maxRetries: 3 });
    }
    if (snaps.length) ctx.db.delete(snapshots).where(inArray(snapshots.id, snaps.map((s) => s.id))).run();
  }
}

export function markDropped(ctx: Ctx, b: BuildRow, note?: string): void {
  ctx.db
    .update(builds)
    .set({ status: 'dropped', live: false, droppedAt: nowIso(), errorMessage: note ?? b.errorMessage })
    .where(eq(builds.id, b.id))
    .run();
  bus.emit({ type: 'build.changed', projectId: b.projectId, branchId: b.branchId, buildId: b.id });
}

export async function dropBuild(ctx: Ctx, b: BuildRow, log: Log): Promise<void> {
  const cfg = ctx.store.require(b.projectId);
  await dropBuildResources(ctx, cfg, b, log);
  markDropped(ctx, b);
  audit(ctx, { projectId: b.projectId, action: 'build.drop', target: `${b.composeProject}#${b.number}`, params: { db: b.dbName } });
}
