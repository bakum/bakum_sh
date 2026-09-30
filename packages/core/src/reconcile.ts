import fs from 'node:fs';
import path from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { BmError, type Discrepancy, type Orphan, type ProjectConfig, type BuildStep } from '@bm/shared';
import type { Ctx } from './context';
import { branches, builds, snapshots, type JobRow } from './db/schema';
import { docker, dockerCli } from './docker/client';
import { refreshContainers } from './docker/watch';
import { anonymousVolumes, removeUnusedVolumes } from './docker/volumes';
import { containerStates } from './docker/state';
import { listDatabases, dropDatabase } from './pg';
import * as git from './git';
import { repoDir } from './git/worktrees';
import { ownedRegistry } from './registry';
import { templateToRegex, SQL_IDENT_RE } from './config/templates';
import { runtimeState } from './state';
import { bus } from './events';
import { audit } from './services/audit';
import { isInside, samePath, toPosix } from './util/paths';
import { log } from './util/logger';
import { nowIso } from './util/time';
import { TRAEFIK_PROJECT } from './docker/traefik';
import { buildContainers } from './builds/drop';

/** Builds of interrupted jobs become `failed` (spec 8.12); their previous live build is untouched. */
export function failInterruptedBuilds(ctx: Ctx, stale: JobRow[]): void {
  const ids = stale.map((j) => j.buildId).filter((x): x is number => !!x);
  const rows = ids.length ? ctx.db.select().from(builds).where(inArray(builds.id, ids)).all() : [];
  // Also catch builds left `building` without a job row (crash between writes).
  const orphanBuilding = ctx.db.select().from(builds).where(inArray(builds.status, ['queued', 'building'])).all();
  for (const b of [...rows, ...orphanBuilding]) {
    if (b.status !== 'queued' && b.status !== 'building') continue;
    const steps: BuildStep[] = (b.steps ?? []).map((s) => (s.status === 'running' ? { ...s, status: 'failed', finishedAt: nowIso(), note: 'прервано' } : s));
    ctx.db
      .update(builds)
      .set({
        status: 'failed',
        steps,
        finishedAt: nowIso(),
        errorMessage: 'Сборка прервана: приложение было закрыто или Core перезапущен. Нажмите «Повторить с шага» или «Отбросить», чтобы удалить созданные ею ресурсы.',
      })
      .where(eq(builds.id, b.id))
      .run();
    audit(ctx, { projectId: b.projectId, action: 'build.interrupted', target: `${b.composeProject}#${b.number}`, result: 'failed' });
    // Interrupted while copying a database: the source build was stopped for CREATE DATABASE … TEMPLATE — start it again.
    const dbStep = (b.steps ?? []).find((s) => s.name === 'database');
    const restartOf = dbStep?.status === 'running' && b.sourceBuildId ? b.sourceBuildId : b.kind === 'update' ? b.previousBuildId : null;
    // `update` stops the live container before -u: after an interruption it is started again (spec 8.3).
    if (restartOf) {
      void buildContainers({ projectId: b.projectId, id: restartOf })
        .then((cs) => Promise.all(cs.filter((c) => !c.oneoff && c.state !== 'running').map((c) => docker.getContainer(c.id).start())))
        .catch((err) => log().warn({ err }, 'restart copy source failed'));
    }
    bus.emit({ type: 'build.changed', projectId: b.projectId, branchId: b.branchId, buildId: b.id });
  }
  for (const j of stale) {
    ctx.toMain({ kind: 'log', level: 'warn', msg: `job ${j.id} (${j.type}) interrupted` });
  }
}

/**
 * Reconciliation (spec 8.12): registry vs `docker` (labels), `git worktree list`, Postgres databases.
 * Differences are only reported (Status page, branch badges) — never deleted silently.
 */
export async function reconcile(ctx: Ctx): Promise<void> {
  const discrepancies: Discrepancy[] = [];
  const orphans: Orphan[] = [];
  try {
    await refreshContainers(ctx);
  } catch (err) {
    log().warn({ err }, 'reconcile: docker unavailable');
  }
  const allContainers = runtimeState.docker.ok
    ? await docker.listContainers({ all: true, filters: { label: ['bm.project'] } }).catch(() => [])
    : [];

  for (const e of ctx.store.list()) {
    const cfg = e.config;
    if (!cfg) continue;
    const reg = ownedRegistry(ctx, cfg.id);
    const rows = ctx.db.select().from(builds).where(eq(builds.projectId, cfg.id)).all();
    const alive = rows.filter((b) => b.status !== 'dropped');
    // Snapshots of databases still in use (D42): the database and its filestore folder are the app's.
    const aliveDbs = new Set(alive.map((b) => b.dbName));
    const snapDbs = new Set(
      (rows.length ? ctx.db.select().from(snapshots).where(inArray(snapshots.buildId, rows.map((b) => b.id))).all() : [])
        .map((s) => s.dbName)
        .filter((n) => aliveDbs.has(n.replace(/_snap_\d+$/, ''))),
    );

    // Containers
    if (runtimeState.docker.ok) {
      for (const b of alive.filter((x) => x.live && (x.status === 'running' || x.status === 'stopped'))) {
        const cs = containerStates.get(b.composeProject);
        if (!cs || cs.buildId !== b.id) {
          discrepancies.push({
            projectId: cfg.id,
            kind: 'container-missing',
            target: b.composeProject,
            text: `Живая сборка ${b.composeProject} #${b.number}: контейнер не найден в Docker (удалён вручную?). Нажмите Rebuild или «Отбросить».`,
          });
        }
      }
      for (const c of allContainers.filter((x) => x.Labels['bm.project'] === cfg.id)) {
        const bid = Number(c.Labels['bm.build']);
        const known = rows.find((b) => b.id === bid);
        const name = (c.Names[0] ?? '').replace(/^\//, '');
        if (!known || known.status === 'dropped') {
          orphans.push({ projectId: cfg.id, kind: 'container', name });
        }
      }
    }

    // Databases
    try {
      const dbs = await listDatabases(cfg.postgres);
      const re = templateToRegex(cfg.naming.db.replace('{project}', cfg.id));
      for (const db of dbs) {
        const base = db.replace(/(_test|_snap_\d+)$/, '');
        if (!re.test(db) && !re.test(base)) continue;
        if (cfg.postgres.protectedDbs.includes(db)) continue;
        const inUse = alive.some((b) => b.dbName === db || `${b.dbName}_test` === db) || snapDbs.has(db);
        if (!inUse) orphans.push({ projectId: cfg.id, kind: 'database', name: db });
      }
      for (const b of alive.filter((x) => x.live && x.status !== 'failed')) {
        if (!dbs.includes(b.dbName)) {
          discrepancies.push({ projectId: cfg.id, kind: 'db-missing', target: b.dbName, text: `БД ${b.dbName} живой сборки #${b.number} отсутствует в Postgres.` });
        }
      }
      runtimeState.postgres.set(cfg.id, { ok: true, text: `${cfg.postgres.host}:${cfg.postgres.port}` });
    } catch (err) {
      runtimeState.postgres.set(cfg.id, { ok: false, text: (err as Error).message });
    }

    // Filestore directories of databases unknown to the registry
    try {
      const re = templateToRegex(cfg.naming.db.replace('{project}', cfg.id));
      if (fs.existsSync(cfg.runtime.filestore.hostDir)) {
        for (const d of fs.readdirSync(cfg.runtime.filestore.hostDir)) {
          if (!re.test(d)) continue;
          if (!aliveDbs.has(d) && !snapDbs.has(d)) orphans.push({ projectId: cfg.id, kind: 'filestore', name: toPosix(path.join(cfg.runtime.filestore.hostDir, d)) });
        }
      }
    } catch {
      /* not accessible */
    }

    // Worktrees
    try {
      const wts = await git.worktreeList(repoDir(cfg));
      const mine = toPosix(path.join(cfg.repo.worktreesDir, cfg.id));
      for (const w of wts) {
        if (!isInside(mine, w.path)) continue;
        if (![...reg.worktrees].some((p) => samePath(p, w.path))) orphans.push({ projectId: cfg.id, kind: 'worktree', name: w.path });
      }
      for (const b of ctx.db.select().from(branches).where(eq(branches.projectId, cfg.id)).all()) {
        if (b.worktreePath && !wts.some((w) => samePath(w.path, b.worktreePath!))) {
          discrepancies.push({ projectId: cfg.id, kind: 'worktree-missing', target: b.worktreePath, text: `Worktree ветки ${b.name} не найден (${b.worktreePath}); будет создан заново при сборке.` });
        }
      }
    } catch {
      /* repo not accessible */
    }
  }

  // Compose projects / containers with bm.* labels of unknown projects
  for (const c of allContainers) {
    const pid = c.Labels['bm.project']!;
    if (!ctx.store.get(pid)) orphans.push({ projectId: null, kind: 'container', name: (c.Names[0] ?? '').replace(/^\//, '') });
  }

  runtimeState.discrepancies = discrepancies;
  runtimeState.orphans = orphans;
  log().info({ discrepancies: discrepancies.length, orphans: orphans.length }, 'reconciled');
  bus.emit({ type: 'system.changed' });
  bus.emit({ type: 'branch.changed' });
}

/**
 * Removes orphans chosen by the user on the Status page. An orphan must look like the app's own resource
 * (template / labels / location) and must not be in the registry or on a protected list.
 */
export async function cleanupOrphans(ctx: Ctx, items: { kind: string; name: string; projectId: string | null }[]): Promise<{ removed: number; errors: string[] }> {
  const errors: string[] = [];
  let removed = 0;
  for (const it of items) {
    try {
      const known = runtimeState.orphans.find((o) => o.kind === it.kind && o.name === it.name && o.projectId === it.projectId);
      if (!known) throw new BmError('NOT_ORPHAN', `«${it.name}» не в списке сирот — обновите Status`);
      const cfg: ProjectConfig | null = it.projectId ? ctx.store.require(it.projectId) : null;
      switch (it.kind) {
        case 'database': {
          if (!cfg || !SQL_IDENT_RE.test(it.name) || cfg.postgres.protectedDbs.includes(it.name)) throw new BmError('PROTECTED', `БД ${it.name} защищена`);
          await dropDatabase(cfg.postgres, it.name);
          break;
        }
        case 'filestore': {
          if (!cfg || !isInside(cfg.runtime.filestore.hostDir, it.name)) throw new BmError('NOT_OWNED', 'Каталог вне filestore проекта');
          if (!templateToRegex(cfg.naming.db.replace('{project}', cfg.id)).test(path.basename(it.name))) throw new BmError('NOT_OWNED', 'Каталог не соответствует шаблону БД');
          await fs.promises.rm(it.name, { recursive: true, force: true });
          break;
        }
        case 'container': {
          const c = await docker.getContainer(it.name).inspect();
          const labels = c.Config.Labels ?? {};
          if (!labels['bm.project'] || c.Name.replace(/^\//, '') === TRAEFIK_PROJECT) throw new BmError('NOT_OWNED', 'У контейнера нет метки bm.project');
          const protectedNames = ctx.store.list().flatMap((e) => e.config?.postgres.protectedContainers ?? []);
          if (protectedNames.includes(c.Name.replace(/^\//, ''))) throw new BmError('PROTECTED', 'Контейнер защищён');
          // D55: anonymous volumes passed on by a recreate survive `down -v`; they go once nothing uses them.
          const volumes = await anonymousVolumes(c.Id);
          const cp = labels['com.docker.compose.project'];
          if (cp && cp.startsWith('bm-')) await dockerCli(['compose', '-p', cp, 'down', '-v', '--remove-orphans']);
          else await docker.getContainer(it.name).remove({ force: true, v: true });
          await removeUnusedVolumes(volumes, (l) => log().info({ container: it.name }, l));
          break;
        }
        case 'worktree': {
          if (!cfg || !isInside(path.join(cfg.repo.worktreesDir, cfg.id), it.name)) throw new BmError('NOT_OWNED', 'worktree вне папки проекта');
          await git.worktreeRemove(repoDir(cfg), it.name, true);
          break;
        }
        default:
          throw new BmError('BAD_KIND', it.kind);
      }
      removed++;
      audit(ctx, { projectId: it.projectId, action: 'orphan.remove', target: `${it.kind}:${it.name}` });
    } catch (err) {
      errors.push(`${it.kind} ${it.name}: ${(err as Error).message}`);
    }
  }
  await reconcile(ctx);
  return { removed, errors };
}
