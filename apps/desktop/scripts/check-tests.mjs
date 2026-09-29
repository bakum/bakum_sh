// Build tests (spec 8.8, D39) on a tiny «Odoo in Docker» project (own Postgres, odoo:19.0): a fresh Development build
// tests the module it changes during `-i` (one failing test → badge Failed, red dot, tests.log); `tests.failBuild`
// keeps the previous live build; a copy of Production tests the changed module on `<db>_test`, removed afterwards.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { launch, bm, shot } from './pw.mjs';
import { SANDBOX, waitJob, waitJobs, branch, lastBuild } from './sandbox.mjs';

const ID = 'bmtests';
const VERSION = '19.0';
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
const TEST_FILE = `${WORK}/addons/bm_probe/tests/test_probe.py`;
const testSource = (failing) => `from odoo.tests.common import TransactionCase


class TestProbe(TransactionCase):
    def test_ok(self):
        self.assertTrue(self.env['res.partner'].search_count([]) >= 0)
${failing === null ? '' : `
    def test_second(self):
        self.assertEqual(1, ${failing ? 2 : 1})
`}`;

/** Bare repository: main — bm_probe with one passing test; feature — adds a failing test to bm_probe. */
function makeOrigin() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(TEST_FILE), { recursive: true });
  fs.writeFileSync(
    `${WORK}/addons/bm_probe/__manifest__.py`,
    `{'name': 'BM probe', 'version': '${VERSION}.1.0.0', 'depends': ['base'], 'license': 'LGPL-3', 'installable': True}\n`,
  );
  fs.writeFileSync(`${WORK}/addons/bm_probe/__init__.py`, '');
  fs.writeFileSync(`${WORK}/addons/bm_probe/tests/__init__.py`, 'from . import test_probe\n');
  fs.writeFileSync(TEST_FILE, testSource(null));
  fs.writeFileSync(`${WORK}/modules_to_install.txt`, 'bm_probe\n');
  fs.writeFileSync(`${WORK}/.gitignore`, '__pycache__/\n*.pyc\n');
  git(ROOT, 'init', '-q', '-b', 'main', 'work');
  git(WORK, 'add', '-A');
  git(WORK, 'commit', '-q', '-m', 'probe');
  git(WORK, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(TEST_FILE, testSource(true));
  git(WORK, 'commit', '-q', '-am', 'failing test');
  git(ROOT, 'clone', '-q', '--bare', 'work', 'origin.git');
  git(WORK, 'remote', 'add', 'origin', `${ROOT}/origin.git`);
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

async function rebuild(win, br) {
  const j = await waitJob(win, (await bm(win, 'builds.rebuild', { branchId: br.id })).jobId);
  return { job: j, build: await lastBuild(win, br.id) };
}

const step = (b, name) => b.steps.find((s) => s.name === name);
const dbExists = (db) => sql('postgres', `SELECT count(*) FROM pg_database WHERE datname='${db}'`) === '1';

async function run(win) {
  const url = makeOrigin();
  const c = await bm(win, 'repo.clone', { url, mirror: true, shallow: false });
  const cj = await waitJob(win, c.jobId);
  check('копия репозитория', cj.status === 'success', cj.error ?? '');
  const d = await bm(win, 'projects.detect', { mirror: c.dir, url });
  const cfg = structuredClone(d.proposals.odoo);
  cfg.id = ID;
  cfg.name = 'Build tests check';
  cfg.naming.db = `bm_${ID}_{slug_}_{build}`;
  cfg.naming.host = `{slug}.${ID}.localhost`;
  cfg.runtime.network = `bm-${ID}`;
  cfg.postgres.protectedContainers = [`bm-${ID}-db`];
  cfg.repo.worktreesDir = `${ROOT}/worktrees`;
  cfg.runtime.filestore.hostDir = `${ROOT}/filestore`;
  cfg.production.backups.dir = null;
  await bm(win, 'projects.create', { yaml: YAML.stringify(cfg) });
  await waitJobs(win, ID, 900000);
  const [prodBr, devBr] = await waitBranches(win, ['main', 'feature']);

  // 1. Fresh Development build: bm_probe changed vs main → its tests run during -i, one fails.
  const eff = await bm(win, 'config.effective', { branchId: devBr.id });
  check('Development по умолчанию: tests.mode changed', JSON.stringify(eff.fields.find((f) => f.path === 'tests.mode')?.value) === '"changed"');
  const r1 = await rebuild(win, devBr);
  const b1 = r1.build;
  check('сборка с упавшим тестом поднялась', r1.job.status === 'success' && b1.status === 'running', r1.job.error ?? b1.errorMessage ?? '');
  check('итог тестов: 1 упал', b1.tests?.failed === 1 && b1.tests.passed >= 1, JSON.stringify(b1.tests));
  check('список упавших', (b1.tests?.failures ?? []).some((f) => f.includes('test_second')), JSON.stringify(b1.tests?.failures));
  check('шаг tests: результат установки', step(b1, 'tests')?.status === 'success' && /упало 1/.test(step(b1, 'tests')?.note ?? ''), step(b1, 'tests')?.note);
  check('кружок ветки красный', (await bm(win, 'branches.get', { branchId: devBr.id })).indicator === 'failed');
  const tl = await bm(win, 'logs.read', { buildId: b1.id, kind: 'tests', tail: 5000 });
  check('tests.log с FAIL', tl.lines.some((l) => /FAIL: TestProbe\.test_second/.test(l)), tl.path);
  await win.evaluate(([pid, id]) => (location.hash = `#/projects/${pid}/branches/${id}/history`), [ID, devBr.id]);
  await win.waitForTimeout(2500);
  check('бейдж Test: Failed в History', (await win.textContent('[data-testid="tests-badge"]'))?.includes('Failed'));
  await shot(win, 'tests-history-failed');

  // 2. failBuild: the build fails at the tests step, the previous live build keeps serving.
  await bm(win, 'branches.setOverrides', { branchId: devBr.id, overrides: { tests: { failBuild: true } } });
  const r2 = await rebuild(win, devBr);
  check('failBuild: сборка failed на шаге tests', r2.build.status === 'failed' && step(r2.build, 'tests')?.status === 'failed', r2.build.errorMessage ?? '');
  check('failBuild: текст ошибки', /tests\.failBuild/.test(r2.build.errorMessage ?? ''), r2.build.errorMessage ?? '');
  const live2 = (await bm(win, 'branches.get', { branchId: devBr.id })).liveBuild;
  check('failBuild: живой осталась прежняя сборка', live2?.id === b1.id && live2.status === 'running', `${live2?.number} ${live2?.status}`);
  await waitJob(win, (await bm(win, 'builds.drop', { buildId: r2.build.id })).jobId);

  // 3. Production (tests.mode none by default): no test run.
  const rp = await rebuild(win, prodBr);
  check('Production собрана', rp.build.status === 'running', rp.build.errorMessage ?? '');
  check('Production: тесты не запускались', rp.build.tests === null && step(rp.build, 'tests')?.status === 'skipped', step(rp.build, 'tests')?.note);

  // 4. Copy of Production + fixed test: tests on <db>_test, removed afterwards.
  fs.writeFileSync(TEST_FILE, testSource(false));
  git(WORK, 'commit', '-q', '-am', 'fix test');
  git(WORK, 'push', '-q', 'origin', 'feature');
  await bm(win, 'git.fetch', { projectId: ID });
  await waitJobs(win, ID);
  await bm(win, 'branches.setOverrides', { branchId: devBr.id, overrides: { database: 'copy:production', onNewCommit: 'none' } });
  const r3 = await rebuild(win, devBr);
  const b3 = r3.build;
  check('копия прода собрана', r3.job.status === 'success' && b3.status === 'running', r3.job.error ?? b3.errorMessage ?? '');
  check('тесты на копии: все прошли', b3.tests?.failed === 0 && b3.tests.errors === 0 && b3.tests.passed >= 2, JSON.stringify(b3.tests));
  check('шаг tests на _test', /на копии bm_bmtests_feature_\d+_test/.test(step(b3, 'tests')?.note ?? ''), step(b3, 'tests')?.note);
  check('_test-БД удалена', !dbExists(`${b3.dbName}_test`));
  check('_test-filestore удалён', !fs.existsSync(`${ROOT}/filestore/${b3.dbName}_test`));
  check('кружок ветки зелёный', (await bm(win, 'branches.get', { branchId: devBr.id })).indicator === 'ok');
  await win.evaluate(([pid, id, bid]) => (location.hash = `#/projects/${pid}/branches/${id}/logs?build=${bid}&source=tests`), [ID, devBr.id, b3.id]);
  await win.waitForTimeout(2500);
  await shot(win, 'tests-log');

  // 5. tests.mode none on the branch.
  await bm(win, 'branches.setOverrides', { branchId: devBr.id, overrides: { database: 'copy:production', onNewCommit: 'none', tests: { mode: 'none' } } });
  const r4 = await rebuild(win, devBr);
  check('tests.mode none: шаг пропущен', r4.build.status === 'running' && r4.build.tests === null && step(r4.build, 'tests')?.note === 'tests.mode: none', step(r4.build, 'tests')?.note);
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
  // The dev profile rewrote the shared bm-traefik with its own networks: the default profile's compose is put back.
  const own = path.join(process.env.LOCALAPPDATA, 'Odoo Branch Manager', 'traefik', 'compose.yml');
  if (fs.existsSync(own)) docker('compose', '-p', 'bm-traefik', '-f', own, 'up', '-d');
}
console.log(`Итого: ${results.filter(Boolean).length} из ${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
