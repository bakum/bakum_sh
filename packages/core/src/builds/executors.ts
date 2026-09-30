import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { BmError } from '@bm/shared';
import { branchDir, type Ctx } from '../context';
import { builds, type BuildRow, type JobRow } from '../db/schema';
import type { JobContext, JobQueue } from '../jobs/queue';
import { dockerCli } from '../docker/client';
import { generateCompose } from '../docker/compose';
import { ensureTraefik } from '../docker/traefik';
import { ensurePostgres } from '../docker/postgres';
import { ensureImage } from '../docker/image';
import { refreshContainers } from '../docker/watch';
import { resolveBranchScope } from '../config/effective';
import { assertBranchFolder, codeSource } from '../git/worktrees';
import { branchRow } from '../services/branch-rows';
import { publishTray } from '../services/tray';
import { audit } from '../services/audit';
import { bus } from '../events';
import { buildContainers, dropBuild } from './drop';
import { configHash, testsLogPath } from './view';
import { runBuild } from './pipeline';
import { runOdooOneOff, assertOdooOk, serverBaseArgs, codeVars, testArgs, testsFailed } from './odoo-cli';
import { assertSqlIdent } from '../config/templates';
import { copyDatabaseByDump } from '../docker/pg-tools';
import { assertOwned } from '../safety';
import { ownedRegistry } from '../registry';
import { copyTree } from '../util/fs-tree';
import * as pg from '../pg';
import { docker } from '../docker/client';
import { sleep } from '../util/time';

function mustBuild(ctx: Ctx, id: number | null): BuildRow {
  const b = id ? ctx.db.select().from(builds).where(eq(builds.id, id)).get() : undefined;
  if (!b) throw new BmError('NO_BUILD', 'Сборка не найдена');
  return b;
}

export function liveCompose(ctx: Ctx, b: BuildRow): string {
  const br = branchRow(ctx, b.branchId);
  if (!br) throw new BmError('NO_BRANCH', 'Ветка сборки удалена');
  const file = path.join(branchDir(ctx, b.projectId, br.slug), 'compose.yml');
  if (!fs.existsSync(file)) throw new BmError('NO_COMPOSE', `Нет compose-файла живой сборки (${file}). Нажмите Rebuild.`);
  return file;
}

export async function compose(ctx: Ctx, b: BuildRow, args: string[], jc: JobContext): Promise<void> {
  const file = liveCompose(ctx, b);
  const r = await dockerCli(['compose', '-p', b.composeProject, '-f', file, ...args], { onLine: jc.log, signal: jc.signal, timeoutMs: 300_000 });
  if (r.exitCode !== 0) throw new BmError('COMPOSE', `docker compose ${args[0]}: ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')}`);
  await refreshContainers(ctx).catch(() => {});
}

async function waitHealthy(b: { projectId: string; id: number }, timeoutSec: number, jc: JobContext): Promise<void> {
  const until = Date.now() + timeoutSec * 1000;
  while (Date.now() < until) {
    const c = (await buildContainers(b)).find((x) => !x.oneoff);
    if (c) {
      const info = await docker.getContainer(c.id).inspect();
      if (info.State.Health?.Status === 'healthy') return;
      if (info.State.Status === 'exited') throw new BmError('CONTAINER_EXITED', `Контейнер остановился (код ${info.State.ExitCode}). См. odoo.log.`);
    }
    if (jc.signal.aborted) throw new BmError('CANCELLED', 'Отменено');
    await sleep(3000);
  }
  throw new BmError('HEALTHCHECK', `Сборка не ответила за ${timeoutSec} с`);
}

const done = (ctx: Ctx, b: BuildRow, action: string): void => {
  audit(ctx, { projectId: b.projectId, action: `build.${action}`, target: `${b.composeProject}#${b.number}` });
  bus.emit({ type: 'build.changed', projectId: b.projectId, branchId: b.branchId, buildId: b.id });
  publishTray(ctx);
};

/** Rewrites compose.yml of a live build from the current configuration; returns the new config hash. */
export function writeLiveCompose(ctx: Ctx, b: BuildRow): string {
  const br = branchRow(ctx, b.branchId);
  if (!br) throw new BmError('NO_BRANCH', 'Ветка сборки удалена');
  const cfg = ctx.store.require(b.projectId);
  const scope = resolveBranchScope(cfg, br.name, br.stage, br.overrides).scope;
  const code = codeSource(cfg, br, scope).dir;
  if (!code) throw new BmError('NO_WORKTREE', 'Worktree ветки не найден — нужен Rebuild');
  const file = path.join(branchDir(ctx, cfg.id, br.slug), 'compose.yml');
  const vars = codeVars(cfg, code);
  const text = generateCompose({
    cfg,
    scope,
    branch: { id: br.id, name: br.name, slug: br.slug, stage: br.stage },
    build: { id: b.id, number: b.number, dbName: b.dbName, host: b.host, composeProject: b.composeProject, debugPort: b.debugPort },
    worktree: code,
    addonsPath: vars.addonsPath as string | undefined,
    proxyPort: ctx.proxyPort ?? ctx.store.app.proxyPort,
    odooArgs: serverBaseArgs(cfg, vars),
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return configHash(cfg, scope, ctx.proxyPort ?? ctx.store.app.proxyPort);
}

/** «Применить» (spec 9.1): recreate the container with the current configuration, the database is kept. */
async function applyConfig(ctx: Ctx, job: JobRow, jc: JobContext): Promise<void> {
  const b = mustBuild(ctx, job.buildId);
  await assertBranchFolder(ctx, b.branchId);
  const cfg = ctx.store.require(b.projectId);
  await ensureTraefik(ctx);
  await ensurePostgres(ctx, cfg, jc.log);
  // A changed Dockerfile (runtime.build, D46) is what «Применить» is about: the image is rebuilt first.
  const br = branchRow(ctx, b.branchId);
  if (br) await ensureImage(cfg, resolveBranchScope(cfg, br.name, br.stage, br.overrides).scope.image, jc.log, jc.signal);
  const hash = writeLiveCompose(ctx, b);
  jc.log('docker compose up -d (пересоздание контейнера, БД не трогается)');
  await compose(ctx, b, ['up', '-d', '--remove-orphans'], jc);
  await waitHealthy(b, cfg.runtime.healthcheck.timeoutSec, jc);
  ctx.db.update(builds).set({ configHash: hash, status: 'running' }).where(eq(builds.id, b.id)).run();
  done(ctx, b, 'applyConfig');
}

/** Manual -i / -u from the Tools tab: stop → odoo -i/-u → start. */
async function modulesJob(ctx: Ctx, job: JobRow, jc: JobContext): Promise<void> {
  const b = mustBuild(ctx, job.buildId);
  await assertBranchFolder(ctx, b.branchId);
  const cfg = ctx.store.require(b.projectId);
  const p = job.params as { install?: string[]; update?: string[] };
  const file = liveCompose(ctx, b);
  await ensurePostgres(ctx, cfg, jc.log);
  await compose(ctx, b, ['stop'], jc);
  try {
    const br = branchRow(ctx, b.branchId);
    const code = br ? codeSource(cfg, br, resolveBranchScope(cfg, br.name, br.stage, br.overrides).scope).dir : null;
    const cmd = ['odoo', ...serverBaseArgs(cfg, codeVars(cfg, code)), '-d', b.dbName, '--stop-after-init', '--no-http'];
    if (p.install?.length) cmd.push('-i', p.install.join(','));
    if (p.update?.length) cmd.push('-u', p.update.join(','));
    const r = await runOdooOneOff({ composeFile: file, project: b.composeProject, cmd, log: jc.log, signal: jc.signal });
    assertOdooOk(r, 'Модули');
  } finally {
    await compose(ctx, b, ['start'], jc);
  }
  done(ctx, b, 'modules');
}

/**
 * Manual tests (D53, Tools tab and `bm test`): like the build's tests step, on a temporary copy <db>_test of the live
 * database (`cloneMethod`: template stops the running container for the copy, dump does not), `-u <modules>` with
 * --test-enable. The result becomes the build's Test badge and tests.log; failed tests fail the job.
 */
async function testsJob(ctx: Ctx, job: JobRow, jc: JobContext): Promise<void> {
  const b = mustBuild(ctx, job.buildId);
  await assertBranchFolder(ctx, b.branchId);
  const cfg = ctx.store.require(b.projectId);
  const br = branchRow(ctx, b.branchId);
  if (!br) throw new BmError('NO_BRANCH', 'Ветка сборки удалена');
  const scope = resolveBranchScope(cfg, br.name, br.stage, br.overrides).scope;
  const mods = (job.params as { modules?: string[] }).modules ?? [];
  const file = liveCompose(ctx, b);
  await ensurePostgres(ctx, cfg, jc.log);
  const installed = await pg.installedModules(cfg.postgres, b.dbName);
  const missing = mods.filter((m) => !installed.has(m));
  if (missing.length) {
    throw new BmError('NOT_INSTALLED', `Модули не установлены в базе сборки: ${missing.join(', ')}. Сначала установите их (-i): «Модули вручную» или bm modules.`);
  }
  const testDb = assertSqlIdent(`${b.dbName}_test`);
  const fsDir = path.join(cfg.runtime.filestore.hostDir, testDb);
  const reg = ownedRegistry(ctx, cfg.id);
  const cleanup = async (): Promise<void> => {
    if (await pg.dbExists(cfg.postgres, testDb)) {
      assertOwned(cfg, { kind: 'db', name: testDb }, reg);
      jc.log(`DROP DATABASE ${testDb}`);
      await pg.dropDatabase(cfg.postgres, testDb);
    }
    if (fs.existsSync(fsDir)) {
      assertOwned(cfg, { kind: 'filestore', path: fsDir, db: testDb }, reg);
      await fs.promises.rm(fsDir, { recursive: true, force: true, maxRetries: 3 });
    }
  };
  const out = b.logPath ? fs.createWriteStream(testsLogPath(b.logPath), { flags: 'w' }) : null;
  const tl = (l: string): void => {
    jc.log(l);
    out?.write(`${l}\n`);
  };
  await cleanup();
  try {
    if (scope.cloneMethod === 'dump') {
      tl(`pg_dump ${b.dbName} → ${testDb} (cloneMethod: dump, сборка не останавливается)`);
      await pg.createEmpty(cfg.postgres, testDb);
      await copyDatabaseByDump({ cfg, buildId: b.id, src: b.dbName, dst: testDb, log: jc.log, signal: jc.signal });
    } else {
      // CREATE DATABASE … TEMPLATE needs a source without connections: the running build is stopped for the copy.
      const running = (await buildContainers(b)).some((c) => !c.oneoff && c.state === 'running');
      if (running) await compose(ctx, b, ['stop'], jc);
      try {
        tl(`CREATE DATABASE "${testDb}" TEMPLATE "${b.dbName}"`);
        await pg.createFromTemplate(cfg.postgres, testDb, b.dbName);
      } finally {
        if (running) await compose(ctx, b, ['start'], jc);
      }
    }
    const srcFs = path.join(cfg.runtime.filestore.hostDir, b.dbName);
    if (fs.existsSync(srcFs)) await copyTree(srcFs, fsDir, scope.filestoreCopy, jc.log);
    tl(`[tests] модули: ${mods.join(', ')}`);
    const code = codeSource(cfg, br, scope).dir;
    const cmd = ['odoo', ...serverBaseArgs(cfg, codeVars(cfg, code)), '-d', testDb, '--stop-after-init', '--no-http', '-u', mods.join(','), ...testArgs(scope.tests, mods)];
    const res = await runOdooOneOff({ composeFile: file, project: b.composeProject, cmd, log: tl, signal: jc.signal });
    assertOdooOk(res, `Тесты на копии ${testDb}`);
    if (!res.summary.tests) tl('[tests] итоговой строки тестов нет: ни один тест не совпал с --test-tags');
    const t = res.summary.tests ?? { passed: 0, failed: 0, errors: 0, warnings: 0, failures: [] };
    const summary = `пройдено ${t.passed}, упало ${t.failed}, ошибок ${t.errors}`;
    tl(`[tests] ${summary}`);
    ctx.db.update(builds).set({ tests: t }).where(eq(builds.id, b.id)).run();
    audit(ctx, { projectId: b.projectId, action: 'build.tests', target: `${b.composeProject}#${b.number}`, params: { modules: mods, ...t, failures: t.failures.length } });
    bus.emit({ type: 'build.changed', projectId: b.projectId, branchId: b.branchId, buildId: b.id });
    if (testsFailed(t)) throw new BmError('TESTS_FAILED', `Тесты не прошли: ${summary}.${t.failures.length ? `\n${t.failures.slice(0, 10).join('\n')}` : ''}\nПодробности — tests.log (вкладка Logs).`);
  } finally {
    out?.end();
    await cleanup().catch((e) => jc.log(`[warn] не удалось удалить ${testDb}: ${(e as Error).message}`));
  }
}

/** Jobs on a build refuse while another branch is open in the user's folder (D59); only stop does not. */
export function registerBuildExecutors(q: JobQueue): void {
  q.register('build', runBuild);
  q.register('import_backup', runBuild);
  q.register('drop', async (ctx, job, jc) => {
    const b = mustBuild(ctx, job.buildId);
    await assertBranchFolder(ctx, b.branchId, { usable: false });
    const buildLog = b.logPath ? fs.createWriteStream(b.logPath, { flags: 'a' }) : null;
    await dropBuild(ctx, b, (l) => {
      jc.log(l);
      buildLog?.write(`[drop] ${l}\n`);
    });
    buildLog?.end();
    await refreshContainers(ctx).catch(() => {});
    publishTray(ctx);
  });
  q.register('start', async (ctx, job, jc) => {
    const b = mustBuild(ctx, job.buildId);
    await assertBranchFolder(ctx, b.branchId);
    await ensurePostgres(ctx, ctx.store.require(b.projectId), jc.log);
    await compose(ctx, b, ['up', '-d', '--remove-orphans'], jc);
    done(ctx, b, 'start');
  });
  q.register('stop', async (ctx, job, jc) => {
    const b = mustBuild(ctx, job.buildId);
    await compose(ctx, b, ['stop'], jc);
    done(ctx, b, 'stop');
  });
  q.register('restart', async (ctx, job, jc) => {
    const b = mustBuild(ctx, job.buildId);
    await assertBranchFolder(ctx, b.branchId);
    await ensurePostgres(ctx, ctx.store.require(b.projectId), jc.log);
    await compose(ctx, b, ['restart'], jc);
    done(ctx, b, 'restart');
  });
  q.register('apply_config', applyConfig);
  q.register('modules', modulesJob);
  q.register('tests', testsJob);
}
