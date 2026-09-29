import fs from 'node:fs';
import path from 'node:path';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { BmError, BUILD_STEPS, type BuildStep, type BuildStepName, type ProjectConfig, type ResolvedBranchScope, type TestsResult } from '@bm/shared';
import { branchDir, type Ctx } from '../context';
import { branches, builds, type BranchRow, type BuildRow, type JobRow } from '../db/schema';
import type { JobContext } from '../jobs/queue';
import { resolveBranchScope } from '../config/effective';
import * as git from '../git';
import { assertFolderUsable, codeSource, ensureWorktree, type CodeSource } from '../git/worktrees';
import { docker, dockerCli } from '../docker/client';
import { ODOO_SERVICE, dataDirOf, generateCompose } from '../docker/compose';
import { ensureTraefik } from '../docker/traefik';
import { ensurePostgres } from '../docker/postgres';
import { ensureImage } from '../docker/image';
import { refreshContainers } from '../docker/watch';
import * as pg from '../pg';
import { assertOwned } from '../safety';
import { ownedRegistry } from '../registry';
import { assertSqlIdent } from '../config/templates';
import { bumpedModules, changedModules, matchInstalled, modulesFromTree, parseModuleList, selectTestModules, splitInstallUpdate, type ModuleInfo } from '../modules';
import { assertOdooOk, dbSubcommand, demoArgs, neutralizeCommand, runOdooOneOff, serverBaseArgs, testArgs, testsFailed, type OneOffResult } from './odoo-cli';
import { copyDatabaseByDump, restoreDumpFile } from '../docker/pg-tools';
import { buildContainers, dropBuildResources, markDropped } from './drop';
import { buildUrl, configHash, liveBuild, testsLogPath } from './view';
import { branchByName, branchRow } from '../services/branch-rows';
import { localWatcher } from '../services/watch-local';
import { publishTray } from '../services/tray';
import { notify } from '../services/notify';
import { audit } from '../services/audit';
import { bus } from '../events';
import { listeningPorts } from '../util/ports';
import { toPosix } from '../util/paths';
import { copyTree } from '../util/fs-tree';
import { log as coreLog } from '../util/logger';
import { nowIso, sleep } from '../util/time';

/** Everything a step needs; re-read from the registry so any step can be retried. */
interface Run {
  ctx: Ctx;
  cfg: ProjectConfig;
  scope: ResolvedBranchScope;
  branch: BranchRow;
  build: BuildRow;
  prevLive: BuildRow | null;
  job: JobRow;
  jc: JobContext;
  log: (l: string) => void;
  buildDir: string;
  composeFile: string;
  liveComposeFile: string;
}

class StepSkip extends Error {}
const skip = (note: string): never => {
  throw new StepSkip(note);
};

/** Code source of the branch (mirror worktree or the user's folder, D33), with the current worktree path. */
const src = (r: Run): CodeSource => codeSource(r.cfg, r.branch, r.scope);

function refreshBuild(r: Run): void {
  r.build = r.ctx.db.select().from(builds).where(eq(builds.id, r.build.id)).get()!;
}

function patchBuild(r: Run, patch: Partial<BuildRow>): void {
  r.ctx.db.update(builds).set(patch).where(eq(builds.id, r.build.id)).run();
  refreshBuild(r);
  bus.emit({ type: 'build.changed', projectId: r.cfg.id, branchId: r.branch.id, buildId: r.build.id });
}

function setStep(r: Run, name: BuildStepName, patch: Partial<BuildStep>): void {
  const steps = (r.build.steps ?? []).map((s) => (s.name === name ? { ...s, ...patch } : s));
  patchBuild(r, { steps });
}

/** Writes the compose file of this build (debug port, DB, code folder) into its build folder. */
function writeBuildCompose(r: Run): void {
  const code = src(r).dir;
  if (!code) throw new BmError('NO_WORKTREE', 'Worktree ветки не создан');
  const text = generateCompose({
    cfg: r.cfg,
    scope: r.scope,
    branch: { id: r.branch.id, name: r.branch.name, slug: r.branch.slug, stage: r.branch.stage },
    build: { id: r.build.id, number: r.build.number, dbName: r.build.dbName, host: r.build.host, composeProject: r.build.composeProject, debugPort: r.build.debugPort },
    worktree: code,
  });
  fs.mkdirSync(r.buildDir, { recursive: true });
  fs.writeFileSync(r.composeFile, text, 'utf8');
}

// ---------------------------------------------------------------------------------------------------------------
// Steps

async function stepCode(r: Run): Promise<string> {
  const { ctx, cfg } = r;
  let sha: string | null;
  const from = src(r);
  if (from.kind === 'folder') {
    // The user's own clone: mounted as is, only read (D33).
    await assertFolderUsable(from.dir);
    sha = await git.headSha(from.dir);
    if (!sha) throw new BmError('NO_HEAD', `Не удалось прочитать HEAD в папке ${from.dir}`);
    const current = await git.currentBranch(from.dir);
    if (current !== r.branch.name) r.log(`[warn] в папке ${from.dir} открыта ветка ${current ?? '(detached)'}, а не ${r.branch.name}: собирается то, что лежит в папке`);
    const dirty = await git.uncommittedFiles(from.dir);
    if (dirty.length) r.log(`незакоммиченных файлов в папке: ${dirty.length} — они попадут в сборку`);
  } else {
    const wt = await ensureWorktree(ctx, cfg, r.branch);
    r.branch = branchRow(ctx, r.branch.id)!;
    sha = (r.job.params.targetSha as string | null) ?? (await git.remoteSha(from.repo, cfg.repo.remote, r.branch.name));
    if (!sha) throw new BmError('NO_BRANCH_REF', `Ветка ${r.branch.name} не найдена в ${cfg.repo.remote}. Выполните fetch.`);
    const dirty = (await git.statusPorcelain(wt)).trim();
    if (dirty) {
      throw new BmError(
        'WORKTREE_DIRTY',
        `В worktree ${wt} есть незакоммиченные изменения, а код ветки берётся из ${cfg.repo.remote}. Ничего не затирается: ` +
          `перенесите или отмените изменения (правьте код в своей папке, см. Editor → «Код из моей папки»).\n${dirty}`,
      );
    }
    const head = await git.headSha(wt);
    if (head !== sha) {
      r.log(`git checkout --detach ${sha}`);
      await git.checkoutDetach(wt, sha);
    }
  }
  const base = r.prevLive?.commitSha ?? latestBuiltSha(r);
  const known = base && base !== sha && (await git.revParse(from.repo, base));
  const commits = await git.commitsBetween(from.repo, known ? base : null, sha, known ? 200 : 1);
  patchBuild(r, { commitSha: sha, commits });
  ctx.db
    .update(branches)
    .set(from.kind === 'mirror' ? { lastSeenRemoteSha: sha } : { lastSeenLocalSha: sha })
    .where(eq(branches.id, r.branch.id))
    .run();
  return `${sha.slice(0, 7)}${from.kind === 'folder' ? ' из вашей папки' : ''}, коммитов: ${commits.length}`;
}

function latestBuiltSha(r: Run): string | null {
  const prev = r.ctx.db
    .select()
    .from(builds)
    .where(and(eq(builds.branchId, r.branch.id), ne(builds.id, r.build.id)))
    .orderBy(desc(builds.number))
    .all()
    .find((b) => b.commitSha);
  return prev?.commitSha ?? null;
}

async function stepPort(r: Run): Promise<string> {
  const { ctx } = r;
  if (r.build.kind === 'update' && r.prevLive?.debugPort) {
    patchBuild(r, { debugPort: r.prevLive.debugPort });
    return `${r.prevLive.debugPort} (как у живой сборки)`;
  }
  const [lo, hi] = ctx.store.app.debugPortRange;
  const used = new Set(
    ctx.db
      .select({ p: builds.debugPort })
      .from(builds)
      .where(and(inArray(builds.status, ['queued', 'building', 'running', 'stopped']), ne(builds.id, r.build.id)))
      .all()
      .map((x) => x.p)
      .filter((p): p is number => !!p),
  );
  const busy = await listeningPorts();
  if (r.build.debugPort && !used.has(r.build.debugPort) && !busy.has(r.build.debugPort)) return String(r.build.debugPort);
  for (let p = lo; p <= hi; p++) {
    if (used.has(p) || busy.has(p)) continue;
    patchBuild(r, { debugPort: p });
    return String(p);
  }
  throw new BmError('NO_PORT', `Нет свободных debug-портов в диапазоне ${lo}–${hi} (debugPortRange в app.yaml). Отбросьте ненужные сборки.`);
}

/** Source build for `copy:<branch>` (spec 8.3): the live build of that branch. */
function copySource(r: Run): BuildRow {
  const src = r.build.dbSource.slice('copy:'.length);
  const name = src === 'production' ? r.cfg.production.branch : src;
  const b = branchByName(r.ctx, r.cfg.id, name);
  if (!b) throw new BmError('NO_SOURCE', `Ветка-источник БД «${name}» не добавлена в проект. Добавьте её или измените database в настройках стадии.`);
  const live = liveBuild(r.ctx, b.id);
  if (!live) {
    throw new BmError(
      'NO_SOURCE',
      src === 'production'
        ? 'Нет живой сборки Production: сначала соберите её (Rebuild на ветке Production) или импортируйте бэкап прода (Backups → Импортировать).'
        : `У ветки-источника «${name}» нет живой сборки: сначала соберите её.`,
    );
  }
  return live;
}

/** A production backup made by `pg_dump -Fc` (spec 8.4), as opposed to an Odoo backup `.zip`. */
export const isDumpBackup = (file: string): boolean => /\.dump$/i.test(file);

async function dropOwnDb(r: Run, db: string): Promise<void> {
  if (!(await pg.dbExists(r.cfg.postgres, db).catch(() => false))) return;
  assertOwned(r.cfg, { kind: 'db', name: db }, ownedRegistry(r.ctx, r.cfg.id));
  r.log(`DROP DATABASE ${db}`);
  await pg.dropDatabase(r.cfg.postgres, db);
}

/**
 * `.dump` of production (spec 8.4): empty database + `pg_restore --no-owner`, then the mandatory `odoo neutralize`.
 * A dump has no filestore (see stepFilestore).
 */
async function restoreDump(r: Run, file: string): Promise<void> {
  const { cfg, build } = r;
  // A retry starts over: a half-restored database is not trusted.
  await dropOwnDb(r, build.dbName);
  await pg.createEmpty(cfg.postgres, build.dbName);
  r.log(`pg_restore --no-owner ${path.basename(file)} → ${build.dbName}`);
  const res = await restoreDumpFile({ cfg, buildId: build.id, file, db: build.dbName, log: r.log, signal: r.jc.signal });
  const fp = await pg.dbFingerprint(cfg.postgres, build.dbName);
  if (fp.modules <= 0) {
    throw new BmError(
      'RESTORE_FAILED',
      `После pg_restore в ${build.dbName} нет установленных модулей Odoo (код ${res.exitCode}): файл не является дампом БД Odoo в формате pg_dump -Fc. См. build.log.`,
    );
  }
  if (res.exitCode !== 0) r.log(`[warn] pg_restore завершился с кодом ${res.exitCode}: часть объектов не восстановлена (обычно роли и права сервера прода), подробности выше`);
  r.log(`восстановлено: таблиц ${fp.tables}, установленных модулей ${fp.modules}`);
  const { cmd, env } = neutralizeCommand(cfg, build.dbName);
  const n = await runOdooOneOff({ composeFile: r.composeFile, project: build.composeProject, cmd, env, log: r.log, signal: r.jc.signal });
  assertOdooOk(n, 'Нейтрализация (odoo neutralize)');
}

async function stepDatabase(r: Run): Promise<string> {
  const { ctx, cfg, build } = r;
  if (build.kind === 'update') skip('БД живой сборки сохраняется');
  assertSqlIdent(build.dbName);
  const reg = ownedRegistry(ctx, cfg.id);
  if (build.dbSource.startsWith('backup:')) {
    const file = (r.job.params.backupPath as string | null) ?? path.join(cfg.production.backups.dir ?? '', build.dbSource.slice(7));
    if (!fs.existsSync(file)) throw new BmError('NO_BACKUP', `Файл бэкапа не найден: ${file}`);
    assertOwned(cfg, { kind: 'db', name: build.dbName }, reg);
    patchBuild(r, { createdResources: { ...build.createdResources, db: true, filestore: true } });
    if (isDumpBackup(file)) await restoreDump(r, file);
    else {
      const inContainer = `/bm-backup/${path.basename(file)}`;
      // spec 8.4: `odoo db load -f -n` — restore DB + filestore and neutralize in one Odoo call (no -c before `db`).
      const { cmd, env } = dbSubcommand(cfg, ['load', '-f', '-n', build.dbName, inContainer]);
      const res = await runOdooOneOff({
        composeFile: r.composeFile,
        project: build.composeProject,
        cmd,
        env,
        volumes: [`${toPosix(file)}:${inContainer}:ro`],
        log: r.log,
        signal: r.jc.signal,
      });
      assertOdooOk(res, 'Восстановление бэкапа (odoo db load)');
      if (!(await pg.dbExists(cfg.postgres, build.dbName))) throw new BmError('RESTORE_FAILED', `После odoo db load БД ${build.dbName} не появилась. См. build.log.`);
    }
    // Mandatory neutralization is part of `load -n`; then postRestore SQL and its verification (spec 8.4).
    for (const sqlFile of cfg.production.postRestore.sql) {
      if (!fs.existsSync(sqlFile)) throw new BmError('NO_SQL', `postRestore.sql: файл ${sqlFile} не найден`);
      r.log(`postRestore: ${sqlFile}`);
      await pg.runScript(cfg.postgres, build.dbName, fs.readFileSync(sqlFile, 'utf8'));
    }
    if (cfg.production.postRestore.verifySql) {
      const rows = await pg.query<Record<string, unknown>>(cfg.postgres, build.dbName, cfg.production.postRestore.verifySql);
      const first = rows[0] ? Object.values(rows[0])[0] : 0;
      const ok = rows.length === 0 || (rows.length === 1 && Number(first) === 0);
      r.log(`verifySql → ${rows.length} строк, значение ${String(first)}`);
      if (!ok) {
        throw new BmError('VERIFY_FAILED', `Проверка postRestore.verifySql не прошла (вернула ${String(first)}): в БД остались параметры лицензии прода. Сборка остановлена.`);
      }
    }
    return `восстановлена из ${path.basename(file)}, нейтрализована, postRestore выполнен`;
  }
  if (build.dbSource.startsWith('copy:')) {
    const src = copySource(r);
    patchBuild(r, {
      sourceBuildId: src.id,
      sourceMirrorBuildId: src.stage === 'production' ? src.id : (src.sourceMirrorBuildId ?? null),
      createdResources: { ...r.build.createdResources, db: true },
    });
    if (await pg.dbExists(cfg.postgres, build.dbName)) return `${build.dbName} уже существует (повтор шага)`;
    if (r.scope.cloneMethod === 'dump') {
      // The source keeps serving: pg_dump reads a consistent snapshot of a live database.
      const t0 = Date.now();
      r.log(`pg_dump ${src.dbName} → pg_restore ${build.dbName} (cloneMethod: dump, источник не останавливается)`);
      await pg.createEmpty(cfg.postgres, build.dbName);
      try {
        await copyDatabaseByDump({ cfg, buildId: build.id, src: src.dbName, dst: build.dbName, log: r.log, signal: r.jc.signal });
        const a = await pg.dbFingerprint(cfg.postgres, src.dbName);
        const b = await pg.dbFingerprint(cfg.postgres, build.dbName);
        if (a.tables !== b.tables || a.modules !== b.modules) {
          throw new BmError('PG_VERIFY', `Копия ${build.dbName} не совпадает с ${src.dbName}: таблиц ${b.tables} из ${a.tables}, модулей ${b.modules} из ${a.modules}`);
        }
      } catch (err) {
        // A half-restored database must not pass for a finished copy when the step is retried.
        await dropOwnDb(r, build.dbName);
        throw err;
      }
      return `копия ${src.dbName} (сборка #${src.number}) через pg_dump за ${Math.round((Date.now() - t0) / 1000)} с`;
    }
    // The source Odoo is stopped for the copy (connections block CREATE DATABASE … TEMPLATE).
    const srcContainer = (await buildContainers(src.id)).find((c) => !c.oneoff && c.state === 'running');
    if (srcContainer) {
      assertOwned(cfg, { kind: 'container', name: srcContainer.name, labels: srcContainer.labels }, reg);
      r.log(`stop ${srcContainer.name} на время копирования`);
      await docker.getContainer(srcContainer.id).stop({ t: 20 }).catch(() => {});
    }
    try {
      r.log(`CREATE DATABASE "${build.dbName}" TEMPLATE "${src.dbName}"`);
      await pg.createFromTemplate(cfg.postgres, build.dbName, src.dbName);
    } finally {
      if (srcContainer) {
        r.log(`start ${srcContainer.name}`);
        await docker.getContainer(srcContainer.id).start().catch(() => {});
      }
    }
    return `копия ${src.dbName} (сборка #${src.number})`;
  }
  // fresh
  patchBuild(r, { createdResources: { ...build.createdResources, db: true } });
  await pg.createEmpty(cfg.postgres, build.dbName);
  return 'пустая БД';
}

async function stepFilestore(r: Run): Promise<string> {
  const { cfg, build } = r;
  if (build.kind === 'update') skip('filestore живой сборки сохраняется');
  const dst = path.join(cfg.runtime.filestore.hostDir, build.dbName);
  if (build.dbSource.startsWith('backup:')) {
    if (!isDumpBackup(build.dbSource)) skip('восстановлен вместе с БД (odoo db load)');
    await fs.promises.mkdir(dst, { recursive: true });
    r.log('[warn] в .dump нет filestore: вложения и картинки прода в этой сборке не откроются (нужен бэкап .zip)');
    return 'в .dump нет filestore — пустой каталог';
  }
  patchBuild(r, { createdResources: { ...r.build.createdResources, filestore: true } });
  if (build.dbSource === 'fresh') {
    await fs.promises.mkdir(dst, { recursive: true });
    return 'пустой каталог';
  }
  const src = r.ctx.db.select().from(builds).where(eq(builds.id, build.sourceBuildId!)).get();
  if (!src) throw new BmError('NO_SOURCE', 'Сборка-источник БД не найдена');
  const srcDir = path.join(cfg.runtime.filestore.hostDir, src.dbName);
  if (fs.existsSync(dst)) {
    assertOwned(cfg, { kind: 'filestore', path: dst, db: build.dbName }, ownedRegistry(r.ctx, cfg.id));
    r.log(`повтор шага: удаляю неполный ${dst}`);
    await fs.promises.rm(dst, { recursive: true, force: true });
  }
  if (!fs.existsSync(srcDir)) {
    await fs.promises.mkdir(dst, { recursive: true });
    return `у источника нет filestore (${srcDir}) — пустой каталог`;
  }
  const t0 = Date.now();
  const res = await copyTree(srcDir, dst, r.scope.filestoreCopy, r.log);
  return `${res.files} файлов, ${res.linked ? 'хардлинки' : 'копирование'}, ${Math.round((Date.now() - t0) / 1000)} с`;
}

/** local-tweaks (spec 8.3 step 5): base URL, admin password, extraSql. Mail server → Mailpit is postponed (D43). */
async function applyTweaks(r: Run): Promise<string[]> {
  const { cfg, build, scope } = r;
  const done: string[] = [];
  const port = r.ctx.proxyPort ?? r.ctx.store.app.proxyPort;
  const url = buildUrl(build.host, port);
  if (scope.localTweaks.baseUrl) {
    await pg.query(
      cfg.postgres,
      build.dbName,
      `INSERT INTO ir_config_parameter (key, value, create_date, write_date) VALUES ('web.base.url', $1, now(), now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, write_date = now()`,
      [url],
    );
    done.push(`web.base.url=${url}`);
  }
  if (scope.localTweaks.adminPassword && cfg.connect.adminPassword && build.dbSource !== 'fresh') {
    // Odoo accepts a plaintext password and re-hashes it on the first login (passlib 'plaintext' scheme).
    await pg.query(
      cfg.postgres,
      build.dbName,
      `UPDATE res_users SET password = $1 WHERE id = (SELECT res_id FROM ir_model_data WHERE module = 'base' AND name = 'user_admin')`,
      [cfg.connect.adminPassword],
    );
    await pg.runScript(
      cfg.postgres,
      build.dbName,
      `DO $$ BEGIN
         IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'res_users' AND column_name = 'totp_secret') THEN
           UPDATE res_users SET totp_secret = NULL WHERE id = (SELECT res_id FROM ir_model_data WHERE module = 'base' AND name = 'user_admin');
         END IF;
       END $$;`,
    );
    done.push('пароль admin');
  }
  if (scope.localTweaks.extraSql) {
    for (const s of cfg.extraSql) {
      const sql = /\.sql$/i.test(s.trim()) && fs.existsSync(s.trim()) ? fs.readFileSync(s.trim(), 'utf8') : s;
      await pg.runScript(cfg.postgres, build.dbName, sql);
    }
    if (cfg.extraSql.length) done.push(`extraSql ×${cfg.extraSql.length}`);
  }
  return done;
}

async function stepTweaks(r: Run): Promise<string> {
  if (r.build.kind === 'update') skip('не нужно при обновлении');
  if (r.build.dbSource === 'fresh') skip('для чистой БД — после установки модулей');
  const done = await applyTweaks(r);
  return done.join(', ') || 'нечего менять';
}

async function treeModules(r: Run, sha: string): Promise<ModuleInfo[]> {
  return modulesFromTree(await git.lsTree(src(r).repo, sha));
}

async function wantedModules(r: Run, sha: string): Promise<Set<string>> {
  const f = r.cfg.repo.modulesToInstall;
  if (!f) return new Set();
  const text = await git.showFile(src(r).repo, sha, f);
  return new Set(text ? parseModuleList(text) : []);
}

async function runModules(r: Run, install: string[], update: string[], extra: string[] = [], log = r.log): Promise<OneOffResult> {
  const cmd = ['odoo', ...serverBaseArgs(r.cfg), '-d', r.build.dbName, '--stop-after-init', '--no-http', ...extra];
  if (install.length) cmd.push('-i', install.join(','));
  if (update.length) cmd.push('-u', update.join(','));
  const res = await runOdooOneOff({ composeFile: r.composeFile, project: r.build.composeProject, cmd, log, signal: r.jc.signal });
  assertOdooOk(res, 'Установка / обновление модулей');
  const check = update.includes('all') ? null : [...install, ...update];
  const pending = await pg.pendingModules(r.cfg.postgres, r.build.dbName, check);
  if (pending.length) {
    throw new BmError('MODULES_PENDING', `После обновления модули остались в состоянии to upgrade / to install: ${pending.join(', ')}. См. build.log.`);
  }
  if (res.summary.errors) r.log(`[step] в логе Odoo ошибок: ${res.summary.errors} (сборка продолжена)`);
  return res;
}

/** Commit the build database comes from (spec 8.7): the live build for `update`, the source build for a copy. */
function dbBaseCommit(r: Run): string | null {
  if (r.build.kind === 'update') return r.prevLive?.commitSha ?? null;
  if (!r.build.sourceBuildId) return null;
  return r.ctx.db.select().from(builds).where(eq(builds.id, r.build.sourceBuildId)).get()?.commitSha ?? null;
}

interface ModuleDiff {
  modules: string[];
  /** Directories of the changed modules (repo-relative). */
  dirs: Map<string, string>;
  removed: string[];
  files: number;
  /** `base` is not in the repository: `modules` are all modules of the build commit. */
  unknownBase?: boolean;
}

/** Modules changed between `base` and the build commit, uncommitted edits of the user's folder included (spec 8.7). */
async function modulesChangedSince(r: Run, base: string): Promise<ModuleDiff> {
  const sha = r.build.commitSha!;
  const from = src(r);
  const toMods = await treeModules(r, sha);
  // The source commit may be missing (e.g. unpushed commits of the user's folder, then back to GitHub).
  if (!(await git.revParse(from.repo, base))) return { modules: toMods.map((m) => m.name), dirs: new Map(), removed: [], files: 0, unknownBase: true };
  const extra = from.kind === 'folder' ? await git.uncommittedFiles(from.dir) : [];
  const files = [...new Set([...(base === sha ? [] : await git.diffNames(from.repo, base, sha)), ...extra])];
  if (!files.length) return { modules: [], dirs: new Map(), removed: [], files: 0 };
  const ch = changedModules(files, toMods, await treeModules(r, base), r.cfg.repo.moduleRoots);
  return { modules: ch.changed.map((m) => m.name), dirs: new Map(ch.changed.map((m) => [m.name, m.dir])), removed: ch.removed.map((m) => m.name), files: files.length };
}

/** `version-bumped`: changed modules whose manifest version differs from the database's commit (spec 8.7). */
async function versionBumped(r: Run, base: string, d: ModuleDiff): Promise<string[]> {
  const from = src(r);
  const sha = r.build.commitSha!;
  const mods = await Promise.all(
    d.modules.map(async (name) => {
      const file = `${d.dirs.get(name)}/__manifest__.py`;
      const before = (await git.showFile(from.repo, base, file)) ?? undefined;
      // The user's folder may hold an uncommitted manifest edit: it is part of the build (D33).
      const after = from.kind === 'folder' ? await fs.promises.readFile(path.join(from.dir, file), 'utf8').catch(() => null) : await git.showFile(from.repo, sha, file);
      return { name, before, after };
    }),
  );
  return bumpedModules(mods);
}

/** Where a branch forked off Production: the base of `tests.mode: changed` for a fresh database. */
async function productionMergeBase(r: Run): Promise<string | null> {
  const prod = r.cfg.production.branch;
  if (r.branch.name === prod) return null;
  const from = src(r);
  const prodSha = await git.remoteSha(from.repo, r.cfg.repo.remote, prod);
  return prodSha ? git.mergeBase(from.repo, prodSha, r.build.commitSha!) : null;
}

/** Modules tested while a fresh database is installed (spec 8.8). */
async function freshTestModules(r: Run, install: string[], wanted: Set<string>): Promise<string[]> {
  const mode = r.scope.tests.mode;
  if (mode === 'none') return [];
  let changed = install;
  if (mode === 'changed') {
    const base = await productionMergeBase(r);
    if (base) changed = (await modulesChangedSince(r, base)).modules;
    else r.log('тесты: нет общей истории с веткой Production — тестируются устанавливаемые модули');
  }
  return selectTestModules(mode, { changed, wanted });
}

/** Odoo output of a test run also goes to tests.log (Logs → tests.log). */
function testsLog(r: Run): { log: (l: string) => void; close: () => void } {
  const out = fs.createWriteStream(testsLogPath(r.build.logPath!), { flags: 'w' });
  return {
    log: (l) => {
      r.log(l);
      out.write(`${l}\n`);
    },
    close: () => out.end(),
  };
}

function testsSummary(t: TestsResult): string {
  return `пройдено ${t.passed}, упало ${t.failed}, ошибок ${t.errors}${t.warnings ? `, предупреждений ${t.warnings}` : ''}`;
}

/** Stores the result of a test run; no summary line means no test matched the tags. */
function saveTests(r: Run, t: TestsResult | null): void {
  if (!t) r.log('[tests] итоговой строки тестов нет: ни один тест не совпал с --test-tags');
  const res = t ?? { passed: 0, failed: 0, errors: 0, warnings: 0, failures: [] };
  r.log(`[tests] ${testsSummary(res)}`);
  patchBuild(r, { tests: res });
}

/** Result of the tests step; with `tests.failBuild` failed tests stop the build (the previous live build stays). */
function checkTests(r: Run, where: string): string {
  const t = r.build.tests;
  if (!t) return where;
  if (testsFailed(t) && r.scope.tests.failBuild) {
    const list = t.failures.slice(0, 5).join('\n');
    throw new BmError(
      'TESTS_FAILED',
      `Тесты не прошли (${testsSummary(t)}), а tests.failBuild: true — сборка не поднимается.${list ? `\n${list}` : ''}\nПодробности — в tests.log (вкладка Logs).`,
    );
  }
  return `${testsSummary(t)} (${where})`;
}

/** Stops the live container before `-u` on the shared DB (`update`, spec 8.3). */
async function stopLiveForUpdate(r: Run): Promise<void> {
  if (!r.prevLive) return;
  for (const c of await buildContainers(r.prevLive.id)) {
    if (c.oneoff || c.state !== 'running') continue;
    assertOwned(r.cfg, { kind: 'container', name: c.name, labels: c.labels }, ownedRegistry(r.ctx, r.cfg.id));
    r.log(`stop ${c.name}`);
    await docker.getContainer(c.id).stop({ t: 20 });
  }
}

async function stepModules(r: Run): Promise<string> {
  const { cfg, build, scope } = r;
  const sha = build.commitSha!;
  const wanted = await wantedModules(r, sha);
  const toMods = await treeModules(r, sha);
  const roots = cfg.repo.moduleRoots;

  if (build.dbSource === 'fresh') {
    let install: string[];
    const inst = scope.install;
    if (inst === 'my') install = [...wanted];
    else if (inst === 'roots' || inst === 'full') install = toMods.filter((m) => !roots.length || roots.some((x) => m.dir.startsWith(`${x}/`))).map((m) => m.name);
    else install = inst.list;
    // Enterprise addons in the addons path: the database becomes Enterprise only with web_enterprise installed.
    if (cfg.runtime.enterprise && !install.includes('web_enterprise')) install.push('web_enterprise');
    if (!install.length) install = ['base'];
    // spec 8.8: on a fresh database the tests run during the installation itself.
    const tested = await freshTestModules(r, install, wanted);
    if (scope.tests.mode !== 'none') r.log(tested.length ? `[tests] модули: ${tested.join(', ')}` : '[tests] нет модулей для тестов');
    const tl = tested.length ? testsLog(r) : null;
    try {
      const extra = [...demoArgs(cfg, scope.withDemo), ...(tested.length ? testArgs(scope.tests, tested) : [])];
      const res = await runModules(r, install, [], extra, tl?.log);
      patchBuild(r, { tests: null });
      if (tl) saveTests(r, res.summary.tests);
    } finally {
      tl?.close();
    }
    const tweaks = await applyTweaks(r);
    return `-i ${install.length} модулей${scope.withDemo ? ' с демо' : ''}${r.build.tests ? ', с тестами' : ''}; ${tweaks.join(', ')}`;
  }

  const installed = await pg.installedModules(cfg.postgres, build.dbName);
  let update: string[] = [];
  let install: string[] = [];
  const mode = build.dbSource.startsWith('backup:') ? cfg.production.updateModules : scope.updateModules;
  if (mode === 'all') update = ['all'];
  else if (typeof mode === 'object' && 'installedMatching' in mode) update = matchInstalled(installed, mode.installedMatching);
  else if (typeof mode === 'object' && 'list' in mode) {
    const s = splitInstallUpdate(mode.list, installed, wanted);
    update = s.update;
    install = s.install;
  } else {
    // changed / version-bumped: diff from the commit the database comes from (spec 8.7).
    const base = dbBaseCommit(r);
    const d = base ? await modulesChangedSince(r, base) : null;
    if (!base || !d) {
      r.log('нет коммита-источника для сравнения — модули не обновляются');
    } else if (d.unknownBase) {
      const s = splitInstallUpdate(d.modules.filter((m) => installed.has(m)), installed, wanted);
      update = s.update;
      install = s.install;
      r.log(`коммит-источник ${base.slice(0, 7)} не найден — обновляются все установленные модули репозитория (${update.length})`);
    } else if (d.files) {
      for (const m of d.removed) r.log(`[warn] модуль ${m} удалён из репозитория — в БД не удаляется`);
      let names = d.modules;
      if (mode === 'version-bumped') {
        names = await versionBumped(r, base, d);
        const same = d.modules.filter((m) => !names.includes(m));
        if (same.length) r.log(`version-bumped: версия в манифесте не изменилась — без -u: ${same.join(', ')}`);
      }
      const s = splitInstallUpdate(names, installed, wanted);
      update = s.update;
      install = s.install;
      if (s.none.length) r.log(`не установлены и не в списке «моих»: ${s.none.join(', ')}`);
      r.log(`изменено файлов: ${d.files}; -u ${update.join(',') || '—'}; -i ${install.join(',') || '—'}`);
    } else {
      r.log('коммит не изменился — модули не обновляются');
    }
  }
  if (build.kind === 'update') await stopLiveForUpdate(r);
  if (!update.length && !install.length) return 'нет модулей для -u / -i';
  await runModules(r, install, update);
  return `${update.length ? `-u ${update.join(',')}` : ''}${install.length ? ` -i ${install.join(',')}` : ''}`.trim();
}

/**
 * tests (spec 8.8): a fresh database was tested during `-i` (only the result is checked here); a copied database is
 * tested on a temporary copy `<db>_test` (+ its filestore), removed after the run.
 */
async function stepTests(r: Run): Promise<string> {
  const { cfg, build, scope } = r;
  if (scope.tests.mode === 'none') skip('tests.mode: none');
  if (build.dbSource === 'fresh') {
    if (!build.tests) skip('нет модулей для тестов');
    return checkTests(r, 'при установке модулей');
  }
  const installed = await pg.installedModules(cfg.postgres, build.dbName);
  const base = scope.tests.mode === 'changed' ? dbBaseCommit(r) : null;
  const changed = base ? (await modulesChangedSince(r, base)).modules : [];
  const mods = selectTestModules(scope.tests.mode, { changed, wanted: await wantedModules(r, build.commitSha!), available: installed });
  if (!mods.length) {
    patchBuild(r, { tests: null });
    skip(scope.tests.mode === 'changed' ? 'нет изменённых установленных модулей' : 'нет установленных модулей для тестов');
  }
  const testDb = assertSqlIdent(`${build.dbName}_test`);
  const fsDir = path.join(cfg.runtime.filestore.hostDir, testDb);
  const reg = ownedRegistry(r.ctx, cfg.id);
  const cleanup = async (): Promise<void> => {
    if (await pg.dbExists(cfg.postgres, testDb)) {
      assertOwned(cfg, { kind: 'db', name: testDb }, reg);
      r.log(`DROP DATABASE ${testDb}`);
      await pg.dropDatabase(cfg.postgres, testDb);
    }
    if (fs.existsSync(fsDir)) {
      assertOwned(cfg, { kind: 'filestore', path: fsDir, db: testDb }, reg);
      await fs.promises.rm(fsDir, { recursive: true, force: true, maxRetries: 3 });
    }
  };
  // Leftovers of an interrupted run.
  await cleanup();
  const tl = testsLog(r);
  try {
    // Nothing uses the build database now: `new` has no container yet, `update` stopped it in the modules step.
    r.log(`CREATE DATABASE "${testDb}" TEMPLATE "${build.dbName}"`);
    await pg.createFromTemplate(cfg.postgres, testDb, build.dbName);
    const srcFs = path.join(cfg.runtime.filestore.hostDir, build.dbName);
    if (fs.existsSync(srcFs)) await copyTree(srcFs, fsDir, scope.filestoreCopy, r.log);
    tl.log(`[tests] модули: ${mods.join(', ')}`);
    const cmd = ['odoo', ...serverBaseArgs(cfg), '-d', testDb, '--stop-after-init', '--no-http', '-u', mods.join(','), ...testArgs(scope.tests, mods)];
    const res = await runOdooOneOff({ composeFile: r.composeFile, project: build.composeProject, cmd, log: tl.log, signal: r.jc.signal });
    assertOdooOk(res, `Тесты на копии ${testDb}`);
    saveTests(r, res.summary.tests);
  } finally {
    tl.close();
    await cleanup().catch((e) => r.log(`[warn] не удалось удалить ${testDb}: ${(e as Error).message}`));
  }
  return checkTests(r, `на копии ${testDb}`);
}

/** Waits for the Docker healthcheck of the service container (spec 8.3 step 8). */
async function waitHealthy(r: Run, timeoutSec: number): Promise<void> {
  const until = Date.now() + timeoutSec * 1000;
  let last = '';
  while (Date.now() < until) {
    if (r.jc.signal.aborted) throw new BmError('CANCELLED', 'Операция отменена');
    const c = (await buildContainers(r.build.id)).find((x) => !x.oneoff);
    if (c) {
      const info = await docker.getContainer(c.id).inspect();
      const h = info.State.Health?.Status ?? (info.State.Running ? 'running' : info.State.Status);
      if (h !== last) {
        r.log(`контейнер ${c.name}: ${h}`);
        last = h;
      }
      if (h === 'healthy') return;
      if (!info.State.Running && info.State.Status === 'exited') {
        throw new BmError('CONTAINER_EXITED', `Контейнер сборки остановился (код ${info.State.ExitCode}). См. odoo.log во вкладке Logs.`);
      }
    }
    await sleep(3000);
  }
  throw new BmError('HEALTHCHECK', `Сборка не ответила на ${r.cfg.runtime.healthcheck.path} за ${timeoutSec} с (healthcheck.timeoutSec). См. odoo.log.`);
}

async function composeUp(r: Run, file: string): Promise<void> {
  const res = await dockerCli(['compose', '-p', r.build.composeProject, '-f', file, 'up', '-d', '--remove-orphans'], { onLine: r.log, signal: r.jc.signal, timeoutMs: 300_000 });
  if (res.exitCode !== 0) throw new BmError('COMPOSE_UP', `docker compose up завершился с ошибкой: ${(res.stderr || res.stdout).trim().split('\n').slice(-3).join(' ')}`);
}

async function stepUp(r: Run): Promise<string> {
  await ensureTraefik(r.ctx);
  writeBuildCompose(r);
  // The live compose file is replaced only now: until here the previous live build kept serving the URL.
  if (fs.existsSync(r.liveComposeFile)) fs.copyFileSync(r.liveComposeFile, `${r.liveComposeFile}.prev`);
  fs.copyFileSync(r.composeFile, r.liveComposeFile);
  patchBuild(r, { createdResources: { ...r.build.createdResources, compose: true } });
  await composeUp(r, r.liveComposeFile);
  await waitHealthy(r, r.cfg.runtime.healthcheck.timeoutSec);
  await refreshContainers(r.ctx).catch(() => {});
  return buildUrl(r.build.host, r.ctx.proxyPort ?? r.ctx.store.app.proxyPort);
}

async function stepFinalize(r: Run): Promise<string> {
  const { ctx, build } = r;
  const port = ctx.proxyPort ?? ctx.store.app.proxyPort;
  const hash = configHash(r.cfg, r.scope, port);
  ctx.db.update(builds).set({ live: false }).where(and(eq(builds.branchId, r.branch.id), ne(builds.id, build.id))).run();
  patchBuild(r, { status: 'running', live: true, finishedAt: nowIso(), errorMessage: null, configHash: hash });
  let note = 'сборка работает';
  if (r.prevLive && r.prevLive.id !== build.id) {
    if (build.kind === 'new') {
      await dropBuildResources(ctx, r.cfg, r.prevLive, r.log);
      markDropped(ctx, r.prevLive);
      note += `, сборка #${r.prevLive.number} → DROPPED`;
    } else {
      markDropped(ctx, r.prevLive, `Обновлена сборкой #${build.number}`);
      note += `, #${r.prevLive.number} обновлена`;
    }
  }
  ctx.db.update(branches).set({ lastActiveAt: nowIso(), pausedReason: null }).where(eq(branches.id, r.branch.id)).run();
  return note;
}

const STEP_FNS: Record<BuildStepName, (r: Run) => Promise<string>> = {
  code: stepCode,
  port: stepPort,
  database: stepDatabase,
  filestore: stepFilestore,
  'local-tweaks': stepTweaks,
  modules: stepModules,
  tests: stepTests,
  up: stepUp,
  finalize: stepFinalize,
};

/** Puts the previous live build back after a failed build (spec 8.3: the live build is not touched). */
async function restorePrevious(r: Run): Promise<void> {
  const prev = r.prevLive;
  if (!prev) return;
  try {
    if (src(r).kind === 'mirror' && prev.commitSha && r.branch.worktreePath && r.build.commitSha !== prev.commitSha) {
      r.log(`откат worktree на коммит живой сборки ${prev.commitSha.slice(0, 7)}`);
      await git.checkoutDetach(r.branch.worktreePath, prev.commitSha).catch((e) => r.log(`откат не удался: ${(e as Error).message}`));
    }
    const upStarted = r.build.steps.find((s) => s.name === 'up')?.status !== 'pending';
    if (upStarted && fs.existsSync(`${r.liveComposeFile}.prev`)) {
      fs.copyFileSync(`${r.liveComposeFile}.prev`, r.liveComposeFile);
      r.log('возврат живой сборки: docker compose up с прежней конфигурацией');
      await dockerCli(['compose', '-p', prev.composeProject, '-f', r.liveComposeFile, 'up', '-d', '--remove-orphans'], { onLine: r.log });
    } else if (r.build.kind === 'update' || upStarted) {
      const c = (await buildContainers(prev.id)).find((x) => !x.oneoff && x.state !== 'running');
      if (c) {
        r.log(`запуск ${c.name}`);
        await docker.getContainer(c.id).start().catch(() => {});
      }
    }
    await refreshContainers(r.ctx).catch(() => {});
  } catch (err) {
    r.log(`не удалось вернуть живую сборку: ${(err as Error).message}`);
  }
}

/** Job `build` / `import_backup`: runs the steps of spec 8.3 (optionally from a given step). */
export async function runBuild(ctx: Ctx, job: JobRow, jc: JobContext): Promise<void> {
  const build0 = ctx.db.select().from(builds).where(eq(builds.id, job.buildId!)).get();
  if (!build0) throw new BmError('NO_BUILD', 'Сборка не найдена');
  const branch = branchRow(ctx, build0.branchId);
  if (!branch) throw new BmError('NO_BRANCH', 'Ветка сборки удалена');
  const cfg = ctx.store.require(build0.projectId);
  const scope = resolveBranchScope(cfg, branch.name, branch.stage, branch.overrides).scope;
  const prevLive = build0.previousBuildId ? (ctx.db.select().from(builds).where(eq(builds.id, build0.previousBuildId)).get() ?? null) : null;
  const dir = branchDir(ctx, cfg.id, branch.slug);
  fs.mkdirSync(path.dirname(build0.logPath!), { recursive: true });
  const out = fs.createWriteStream(build0.logPath!, { flags: 'a' });
  const log = (l: string): void => {
    out.write(`${l}\n`);
  };
  const r: Run = {
    ctx,
    cfg,
    scope,
    branch,
    build: build0,
    prevLive: prevLive && prevLive.live && (prevLive.status === 'running' || prevLive.status === 'stopped') ? prevLive : null,
    job,
    jc,
    log,
    buildDir: path.join(dir, 'builds', String(build0.number)),
    composeFile: path.join(dir, 'builds', String(build0.number), 'compose.yml'),
    liveComposeFile: path.join(dir, 'compose.yml'),
  };
  const from = (job.params.fromStep as BuildStepName | undefined) ?? 'code';
  const startIdx = Math.max(0, BUILD_STEPS.indexOf(from));
  patchBuild(r, { status: 'building', startedAt: r.build.startedAt ?? nowIso(), errorMessage: null, finishedAt: null });
  log(`==> ${cfg.id}/${branch.name} сборка #${build0.number} (${build0.kind}, ${build0.dbSource}, trigger ${build0.trigger})${startIdx ? ` с шага ${from}` : ''} ${nowIso()}`);
  let current: BuildStepName = 'code';
  try {
    // Postgres must be up before any step: the app's own (D30) or the user's container, started when stopped.
    await ensurePostgres(ctx, cfg, log);
    // The Odoo image: built from runtime.build (D46), pulled for «Odoo in Docker», or already there.
    await ensureImage(cfg, scope.image, log, jc.signal);
    // A compose file is needed by one-off runs from the database step on (image, mounts, network).
    for (let i = startIdx; i < BUILD_STEPS.length; i++) {
      const name = BUILD_STEPS[i]!;
      current = name;
      if (jc.signal.aborted) throw new BmError('CANCELLED', 'Сборка отменена');
      if (name === 'database' || (i === startIdx && i > BUILD_STEPS.indexOf('port'))) writeBuildCompose(r);
      setStep(r, name, { status: 'running', startedAt: nowIso(), finishedAt: null, note: undefined });
      log(`[step] ${name}`);
      try {
        const note = await STEP_FNS[name](r);
        setStep(r, name, { status: 'success', finishedAt: nowIso(), note });
        log(`[step] ${name}: ${note}`);
      } catch (err) {
        if (err instanceof StepSkip) {
          setStep(r, name, { status: 'skipped', finishedAt: nowIso(), note: err.message });
          log(`[step] ${name}: пропущен — ${err.message}`);
          continue;
        }
        throw err;
      }
    }
    log(`==> готово ${nowIso()}`);
    audit(ctx, { projectId: cfg.id, action: 'build.success', target: `${branch.name}#${r.build.number}` });
    const url = buildUrl(r.build.host, ctx.proxyPort ?? ctx.store.app.proxyPort);
    const t = r.build.tests;
    if (t && testsFailed(t)) {
      notify(ctx, 'testsFailed', `Тесты упали: ${branch.name}`, `#${r.build.number} работает, ${testsSummary(t)}`, {
        route: `/projects/${cfg.id}/branches/${branch.id}/history`,
      });
    } else {
      notify(ctx, 'buildReady', `Сборка готова: ${branch.name}`, `#${r.build.number} работает — ${url}`, {
        route: `/projects/${cfg.id}/branches/${branch.id}/history`,
        url,
      });
    }
  } catch (err) {
    const cancelled = jc.signal.aborted || (err as BmError).code === 'CANCELLED';
    const msg = cancelled ? 'Сборка отменена' : (err as Error).message;
    log(`[error] шаг ${current}: ${msg}`);
    coreLog().warn({ err, build: r.build.id, step: current }, 'build failed');
    setStep(r, current, { status: 'failed', finishedAt: nowIso(), note: cancelled ? 'отменено' : undefined });
    patchBuild(r, { status: 'failed', finishedAt: nowIso(), errorMessage: `Шаг ${current}: ${msg}` });
    await restorePrevious(r);
    audit(ctx, { projectId: cfg.id, action: 'build.failed', target: `${branch.name}#${r.build.number}`, result: 'failed', params: { step: current, error: msg } });
    const kind = (err as BmError).code === 'TESTS_FAILED' ? 'testsFailed' : 'buildFailed';
    notify(ctx, kind, kind === 'testsFailed' ? `Тесты упали: ${branch.name}` : `Сборка упала: ${branch.name}`, `#${r.build.number}, шаг ${current}: ${msg.split('\n')[0]}`, {
      route: `/projects/${cfg.id}/branches/${branch.id}/history`,
    });
    throw err;
  } finally {
    out.end();
    await localWatcher()?.sync();
    publishTray(ctx);
    bus.emit({ type: 'branch.changed', projectId: cfg.id, branchId: branch.id });
  }
}

/** Container name of the service of a live build (Shell / Terminal). */
export async function serviceContainer(buildId: number): Promise<{ id: string; name: string } | null> {
  const c = (await buildContainers(buildId)).find((x) => !x.oneoff);
  return c ? { id: c.id, name: c.name } : null;
}

export { ODOO_SERVICE, dataDirOf };
