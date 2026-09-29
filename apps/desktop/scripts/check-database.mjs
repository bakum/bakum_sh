// Stage 2 database features (D41) on a tiny «Odoo in Docker» project (own Postgres, odoo:19.0): `cloneMethod: dump`
// copies Production without stopping it; `updateModules: version-bumped` skips a module whose manifest version did not
// change and updates it after a bump; a `.dump` dropped into the backups folder is noticed (notification + audit) and,
// with `autoImport`, restored into a neutralized Production without filestore.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { launch, bm, shot } from './pw.mjs';
import { SANDBOX, waitJob, waitJobs, branch, lastBuild } from './sandbox.mjs';

const ID = 'bmdb';
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=bm', '-c', 'user.email=bm@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
const pause = (ms = 2000) => new Promise((r) => setTimeout(r, ms));
const sql = (db, q) => docker('exec', `bm-${ID}-db`, 'psql', '-U', 'odoo', '-d', db, '-Atc', q);
const ROOT = `${SANDBOX}/${ID}`;
const WORK = `${ROOT}/work`;
const BACKUPS = `${ROOT}/backups`;
const MANIFEST = `${WORK}/addons/bm_probe/__manifest__.py`;
const manifest = (v) => `{'name': 'BM probe', 'version': '19.0.${v}', 'depends': ['base'], 'license': 'LGPL-3'}\n`;

/** main — bm_probe 1.0.0; feature — a README change inside the module, same version. */
function makeOrigin() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(`${WORK}/addons/bm_probe`, { recursive: true });
  fs.mkdirSync(BACKUPS, { recursive: true });
  fs.writeFileSync(MANIFEST, manifest('1.0.0'));
  fs.writeFileSync(`${WORK}/addons/bm_probe/__init__.py`, '');
  fs.writeFileSync(`${WORK}/modules_to_install.txt`, 'bm_probe\n');
  fs.writeFileSync(`${WORK}/.gitignore`, '__pycache__/\n*.pyc\n');
  git(ROOT, 'init', '-q', '-b', 'main', 'work');
  git(WORK, 'add', '-A');
  git(WORK, 'commit', '-q', '-m', 'probe');
  git(WORK, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(`${WORK}/addons/bm_probe/README.md`, 'docs only\n');
  git(WORK, 'add', '-A');
  git(WORK, 'commit', '-q', '-m', 'readme');
  git(ROOT, 'clone', '-q', '--bare', 'work', 'origin.git');
  git(WORK, 'remote', 'add', 'origin', `${ROOT}/origin.git`);
  return `file:///${ROOT}/origin.git`;
}

async function waitFor(what, fn, timeoutMs = 90000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`не дождались: ${what}`);
    await pause();
  }
}

const step = (b, name) => b.steps.find((s) => s.name === name);
const startedAt = (buildId) => {
  const n = docker('ps', '-a', '--filter', `label=bm.build=${buildId}`, '--filter', 'label=com.docker.compose.oneoff=False', '--format', '{{.Names}}').split('\n')[0];
  return docker('inspect', '-f', '{{.State.StartedAt}}', n);
};

async function setYaml(win, fn) {
  const cur = await bm(win, 'projects.get', { projectId: ID });
  const doc = YAML.parseDocument(cur.yaml);
  fn(doc);
  await bm(win, 'projects.update', { projectId: ID, yaml: doc.toString() });
}

/** pg_dump -Fc of a build database, taken inside the project's own Postgres container and copied out. */
function dumpTo(db, file) {
  docker('exec', `bm-${ID}-db`, 'pg_dump', '-U', 'odoo', '-Fc', '-f', '/tmp/bm-check.dump', db);
  docker('cp', `bm-${ID}-db:/tmp/bm-check.dump`, file);
}

async function run(win) {
  const url = makeOrigin();
  const c = await bm(win, 'repo.clone', { url, mirror: true, shallow: false });
  check('копия репозитория', (await waitJob(win, c.jobId)).status === 'success');
  const d = await bm(win, 'projects.detect', { mirror: c.dir, url });
  const cfg = structuredClone(d.proposals.odoo);
  Object.assign(cfg, { id: ID, name: 'Database check' });
  cfg.naming.db = `bm_${ID}_{slug_}_{build}`;
  cfg.naming.host = `{slug}.${ID}.localhost`;
  cfg.runtime.network = `bm-${ID}`;
  cfg.postgres.protectedContainers = [`bm-${ID}-db`];
  cfg.repo.worktreesDir = `${ROOT}/worktrees`;
  cfg.runtime.filestore.hostDir = `${ROOT}/filestore`;
  cfg.production.backups.dir = null;
  await bm(win, 'projects.create', { yaml: YAML.stringify(cfg) });
  await waitJobs(win, ID, 900000);
  const [prodBr, devBr] = await waitFor('ветки', async () => {
    const f = await Promise.all(['main', 'feature'].map((n) => branch(win, ID, n)));
    return f.every(Boolean) ? f : null;
  });

  // 1. Production (fresh), then a copy of it by pg_dump: Production keeps running.
  const pj = await waitJob(win, (await bm(win, 'builds.rebuild', { branchId: prodBr.id })).jobId);
  const prod = await lastBuild(win, prodBr.id);
  check('Production собрана', pj.status === 'success' && prod.status === 'running', prod.errorMessage ?? '');
  const prodStarted = startedAt(prod.id);
  await bm(win, 'branches.setOverrides', {
    branchId: devBr.id,
    overrides: { database: 'copy:production', cloneMethod: 'dump', updateModules: 'version-bumped', tests: { mode: 'none' }, onNewCommit: 'update' },
  });
  const dj = await waitJob(win, (await bm(win, 'builds.rebuild', { branchId: devBr.id })).jobId);
  const dev = await lastBuild(win, devBr.id);
  check('копия через pg_dump собрана', dj.status === 'success' && dev.status === 'running', dev.errorMessage ?? '');
  check('шаг database: pg_dump', /через pg_dump/.test(step(dev, 'database')?.note ?? ''), step(dev, 'database')?.note);
  check('Production не перезапускалась', startedAt(prod.id) === prodStarted, `${prodStarted} → ${startedAt(prod.id)}`);
  check('данные скопированы', sql(dev.dbName, "SELECT state FROM ir_module_module WHERE name='bm_probe'") === 'installed');
  check('контейнер pg-tools удалён', docker('ps', '-a', '--filter', `name=bm-${ID}-pgtool`, '--format', '{{.Names}}') === '');
  const log1 = (await bm(win, 'logs.read', { buildId: dev.id, kind: 'build', tail: 2000 })).lines.join('\n');
  check('version-bumped: README без новой версии → без -u', /version-bumped: версия в манифесте не изменилась — без -u: bm_probe/.test(log1));

  // 2. Version bump → `update` build updates the module.
  fs.writeFileSync(MANIFEST, manifest('1.0.1'));
  git(WORK, 'commit', '-q', '-am', 'bump');
  git(WORK, 'push', '-q', 'origin', 'feature');
  await bm(win, 'git.fetch', { projectId: ID });
  await waitJobs(win, ID);
  const upd = await lastBuild(win, devBr.id);
  check('новый коммит → update', upd.id !== dev.id && upd.kind === 'update' && upd.status === 'running', `${upd.kind} ${upd.status} ${upd.errorMessage ?? ''}`);
  check('version-bumped: -u bm_probe', /-u bm_probe/.test(step(upd, 'modules')?.note ?? ''), step(upd, 'modules')?.note);
  check('версия модуля в БД', sql(upd.dbName, "SELECT latest_version FROM ir_module_module WHERE name='bm_probe'") === '19.0.1.0.1');

  // 3. Backups folder: a new .dump is noticed; with autoImport it becomes the production mirror.
  await setYaml(win, (doc) => {
    doc.setIn(['production', 'backups', 'dir'], BACKUPS);
    doc.setIn(['production', 'backups', 'pattern'], '*.dump');
  });
  await pause(3000);
  dumpTo(prod.dbName, `${BACKUPS}/prod-1.dump`);
  const found1 = await waitFor('audit backup.found prod-1', async () => (await bm(win, 'audit.list', { projectId: ID, action: 'backup.found' })).items.find((a) => a.target === 'prod-1.dump'));
  check('новый бэкап замечен (без автоимпорта)', found1.params.autoImport === false);
  check('импорт не запускался', (await bm(win, 'jobs.list', { projectId: ID, active: true })).length === 0);

  await setYaml(win, (doc) => doc.setIn(['production', 'backups', 'autoImport'], true));
  await pause(3000);
  dumpTo(prod.dbName, `${BACKUPS}/prod-2.dump`);
  await waitFor('audit backup.found prod-2', async () => (await bm(win, 'audit.list', { projectId: ID, action: 'backup.found' })).items.find((a) => a.target === 'prod-2.dump'));
  await waitFor('сборка импорта', async () => (await lastBuild(win, prodBr.id)).trigger === 'import_backup');
  await waitJobs(win, ID, 900000);
  const imp = await lastBuild(win, prodBr.id);
  check('автоимпорт .dump: зеркало прода работает', imp.trigger === 'import_backup' && imp.status === 'running' && imp.dbSource === 'backup:prod-2.dump', `${imp.status} ${imp.errorMessage ?? ''}`);
  check('БД нейтрализована', sql(imp.dbName, "SELECT value FROM ir_config_parameter WHERE key='database.is_neutralized'").toLowerCase() === 'true');
  check('filestore: пустой, с предупреждением', /нет filestore/.test(step(imp, 'filestore')?.note ?? ''), step(imp, 'filestore')?.note);
  check('контейнер pg-tools удалён после restore', docker('ps', '-a', '--filter', `name=bm-${ID}-pgtool`, '--format', '{{.Names}}') === '');
  await win.evaluate(([pid, id]) => (location.hash = `#/projects/${pid}/branches/${id}/backups`), [ID, prodBr.id]);
  await win.waitForTimeout(2000);
  await shot(win, 'database-backups');
}

const { app, win } = await launch();
try {
  const state = await bm(win, 'system.state');
  if (state.firstRun) await bm(win, 'system.completeFirstRun', {});
  await run(win);
} catch (err) {
  check('без исключений', false, err.stack ?? err.message);
} finally {
  if ((await bm(win, 'projects.list')).some((p) => p.id === ID)) {
    const j = await waitJob(win, (await bm(win, 'projects.delete', { projectId: ID, confirm: ID })).jobId);
    console.log(`проект ${ID} удалён: ${j.status}`);
  }
  await app.close();
  const own = path.join(process.env.LOCALAPPDATA, 'Odoo Branch Manager', 'traefik', 'compose.yml');
  if (fs.existsSync(own)) docker('compose', '-p', 'bm-traefik', '-f', own, 'up', '-d');
}
console.log(`Итого: ${results.filter(Boolean).length} из ${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
