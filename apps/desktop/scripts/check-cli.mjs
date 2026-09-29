// Command line bm (D53) on a tiny «Odoo in Docker» project (own Postgres, odoo:19.0): the launchers written by the app
// talk to Core over the named pipe; status, modules, tests (passing and failing), restart; Production is refused;
// with the app closed bm exits with 2. Runs bm.cmd (cmd), bm.cmd from PowerShell and bm from Git Bash.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { launch, bm, shot } from './pw.mjs';
import { SANDBOX, waitJob, waitJobs, branch, lastBuild } from './sandbox.mjs';

const ID = 'bmcli';
const VERSION = '19.0';
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=bm', '-c', 'user.email=bm@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
const pause = (ms = 2000) => new Promise((r) => setTimeout(r, ms));
const BASH = 'C:/Program Files/Git/bin/bash.exe';
const BIN = path.join(process.env.LOCALAPPDATA, 'Odoo Branch Manager (dev)', 'bin');

const ROOT = `${SANDBOX}/${ID}`;
const WORK = `${ROOT}/work`;

function env() {
  const e = { ...process.env };
  delete e.ELECTRON_RUN_AS_NODE;
  return e;
}
/** bm.cmd through cmd.exe, as an assistant in cmd / PowerShell would call it. */
function bmCmd(args, cwd = WORK) {
  const r = spawnSync('cmd.exe', ['/d', '/c', path.join(BIN, 'bm.cmd'), ...args], { cwd, encoding: 'utf8', env: env(), timeout: 900000 });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}
function bmBash(args, cwd = WORK) {
  const sh = path.join(BIN, 'bm').replace(/\\/g, '/');
  const r = spawnSync(BASH, ['-c', `"${sh}" ${args.map((a) => `'${a}'`).join(' ')}`], { cwd, encoding: 'utf8', env: env(), timeout: 900000 });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}
function bmPwsh(args, cwd = WORK) {
  const cmd = `& '${path.join(BIN, 'bm.cmd')}' ${args.join(' ')}; exit $LASTEXITCODE`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', cmd], { cwd, encoding: 'utf8', env: env(), timeout: 900000 });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}
const last = (s) => s.trim().split('\n').slice(-2).join(' | ');

function writeModule(name, body) {
  fs.mkdirSync(`${WORK}/addons/${name}/tests`, { recursive: true });
  fs.writeFileSync(`${WORK}/addons/${name}/__manifest__.py`, `{'name': '${name}', 'version': '${VERSION}.1.0.0', 'depends': ['base'], 'license': 'LGPL-3', 'installable': True}\n`);
  fs.writeFileSync(`${WORK}/addons/${name}/__init__.py`, '');
  fs.writeFileSync(`${WORK}/addons/${name}/tests/__init__.py`, 'from . import test_probe\n');
  fs.writeFileSync(
    `${WORK}/addons/${name}/tests/test_probe.py`,
    `from odoo.tests import TransactionCase, tagged\n\n\n@tagged('post_install', '-at_install')\nclass TestProbe(TransactionCase):\n    def test_probe(self):\n        ${body}\n`,
  );
}

/** main and feature: bm_probe (passing test) and bm_bad (failing test), both installed. */
function makeOrigin() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  writeModule('bm_probe', "self.assertTrue(self.env['res.users'].search_count([]))");
  writeModule('bm_bad', 'self.assertEqual(1, 2)');
  fs.writeFileSync(`${WORK}/modules_to_install.txt`, 'bm_probe\nbm_bad\n');
  fs.writeFileSync(`${WORK}/.gitignore`, '__pycache__/\n*.pyc\n');
  git(ROOT, 'init', '-q', '-b', 'main', 'work');
  git(WORK, 'add', '-A');
  git(WORK, 'commit', '-q', '-m', 'probe');
  git(WORK, 'branch', 'feature');
  git(ROOT, 'clone', '-q', '--bare', 'work', 'origin.git');
  return `file:///${ROOT}/origin.git`;
}

async function waitBranches(win, names, timeoutMs = 120000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const found = await Promise.all(names.map((n) => branch(win, ID, n)));
    if (found.every(Boolean)) return found;
    if (Date.now() > until) throw new Error(`ветки ${names.join(', ')} не появились`);
    await pause();
  }
}

async function run(win) {
  check('bm.cmd, bm и cli.js записаны', ['bm.cmd', 'bm', 'cli.js'].every((f) => fs.existsSync(path.join(BIN, f))), BIN);
  const url = makeOrigin();
  const c = await bm(win, 'repo.clone', { url, mirror: true, shallow: false });
  check('копия репозитория', (await waitJob(win, c.jobId)).status === 'success');
  const d = await bm(win, 'projects.detect', { mirror: c.dir, url });
  const cfg = structuredClone(d.proposals.odoo);
  cfg.id = ID;
  cfg.name = 'CLI check';
  cfg.naming.db = `bm_${ID}_{slug_}_{build}`;
  cfg.naming.host = `{slug}.${ID}.localhost`;
  cfg.runtime.network = `bm-${ID}`;
  cfg.postgres.protectedContainers = [`bm-${ID}-db`];
  cfg.repo.worktreesDir = `${ROOT}/worktrees`;
  cfg.repo.localFolder = WORK;
  cfg.runtime.filestore.hostDir = `${ROOT}/filestore`;
  cfg.production.backups.dir = null;
  // Tests only through bm: the build itself does not run them.
  cfg.stages.development = { ...cfg.stages.development, tests: { mode: 'none' } };
  await bm(win, 'projects.create', { yaml: YAML.stringify(cfg) });
  await waitJobs(win, ID, 900000);
  const [prodBr, devBr] = await waitBranches(win, ['main', 'feature']);
  for (const br of [prodBr, devBr]) {
    const j = await waitJob(win, (await bm(win, 'builds.rebuild', { branchId: br.id })).jobId);
    check(`${br.name} собрана`, j.status === 'success', j.error ?? '');
  }
  const dev = await lastBuild(win, devBr.id);

  // status: the project is found by the current folder (the user's clone).
  let r = bmCmd(['status']);
  check('bm status (cmd, проект по папке)', r.code === 0 && r.out.includes(`Проект ${ID}`) && r.out.includes('feature') && r.out.includes('protected'), r.out + r.err);
  r = bmCmd(['status', '--json'], ROOT);
  const js = r.code === 0 ? JSON.parse(r.out) : null;
  check('bm status --json (из корня стека)', js?.project === ID && js.branches.some((b) => b.branch === 'main' && b.protected), r.err);
  r = bmCmd(['status'], process.env.TEMP);
  check('bm status вне проекта — проект по умолчанию или ошибка с -p', r.code === 0 || r.err.includes('-p'), last(r.out + r.err));

  // modules: Development yes, Production no.
  r = bmCmd(['modules', 'feature', '-u', 'bm_probe']);
  check('bm modules feature -u (cmd)', r.code === 0 && r.out.includes('Готово'), last(r.out + r.err));
  r = bmBash(['modules', 'feature', '-u', 'bm_probe']);
  check('bm modules feature -u (Git Bash)', r.code === 0 && r.out.includes('Готово'), last(r.out + r.err));
  r = bmCmd(['modules', 'main', '-u', 'bm_probe']);
  check('bm modules main — отказ (Production)', r.code === 1 && r.err.includes('защищённая'), last(r.err));
  r = bmCmd(['modules', 'nope', '-u', 'bm_probe']);
  check('bm modules несуществующей ветки — ошибка', r.code === 1 && r.err.includes('нет в проекте'), last(r.err));

  // tests: passing → 0 and the Test badge; failing → 1; the temporary copy is removed.
  r = bmCmd(['test', 'feature', 'bm_probe']);
  let b = await bm(win, 'builds.get', { buildId: dev.id });
  check('bm test feature bm_probe — 0, бейдж Test', r.code === 0 && b.tests?.passed >= 1 && b.tests.failed === 0, `${last(r.out + r.err)} | ${JSON.stringify(b.tests)}`);
  r = bmPwsh(['test', 'feature', 'bm_bad']);
  b = await bm(win, 'builds.get', { buildId: dev.id });
  check('bm test feature bm_bad (PowerShell) — 1, упавший тест в сборке', r.code === 1 && b.tests?.failed >= 1 && r.err.includes('Тесты не прошли'), `${last(r.err)} | ${JSON.stringify(b.tests)}`);
  check('PowerShell: вывод читается (кириллица)', r.out.includes('Задача #'), r.out.split('\n')[0]);
  const dbs = docker('exec', `bm-${ID}-db`, 'psql', '-U', 'odoo', '-d', 'postgres', '-Atc', `SELECT datname FROM pg_database WHERE datname LIKE '%_test'`);
  check('временная копия базы удалена', dbs === '', dbs);
  const jobsList = await bm(win, 'jobs.list', { projectId: ID, limit: 20 });
  check('тесты — задачи в очереди приложения', jobsList.filter((j) => j.type === 'tests').length === 2);

  r = bmCmd(['restart', 'feature']);
  check('bm restart feature', r.code === 0, last(r.out + r.err));

  // Tools tab: the same tests action.
  await win.evaluate(([id, bid]) => (location.hash = `#/projects/${id}/branches/${bid}/tools`), [ID, devBr.id]);
  await pause(1500);
  await shot(win, 'cli-tools-tests');

  r = bmCmd(['help']);
  check('bm help', r.code === 0 && r.out.includes('bm test'), '');
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
  await pause(2000);
  const r = bmCmd(['status'], process.env.TEMP);
  check('приложение закрыто — код 2', r.code === 2 && r.err.includes('не запущен'), last(r.err));
  fs.rmSync(ROOT, { recursive: true, force: true });
  const own = path.join(process.env.LOCALAPPDATA, 'Odoo Branch Manager', 'traefik', 'compose.yml');
  if (fs.existsSync(own)) docker('compose', '-p', 'bm-traefik', '-f', own, 'up', '-d');
}
console.log(`Итого: ${results.filter(Boolean).length} из ${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
