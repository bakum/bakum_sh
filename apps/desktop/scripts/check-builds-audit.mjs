// Builds and Audit Logs (spec 8.11) on a tiny «Odoo in Docker» project (own Postgres, odoo:19.0): three builds (tests
// failed, failBuild, Production), then the Builds filters in the URL, and Audit Logs with filters and a settings diff.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { launch, bm, shot } from './pw.mjs';
import { SANDBOX, waitJob, waitJobs, branch } from './sandbox.mjs';

const ID = 'bmaudit';
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=bm', '-c', 'user.email=bm@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
const pause = (ms = 2000) => new Promise((r) => setTimeout(r, ms));
const ROOT = `${SANDBOX}/${ID}`;
const WORK = `${ROOT}/work`;

/** main — module bm_probe; feature — adds a failing test to it. */
function makeOrigin() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(`${WORK}/addons/bm_probe/tests`, { recursive: true });
  fs.writeFileSync(`${WORK}/addons/bm_probe/__manifest__.py`, `{'name': 'BM probe', 'version': '19.0.1.0.0', 'depends': ['base'], 'license': 'LGPL-3'}\n`);
  fs.writeFileSync(`${WORK}/addons/bm_probe/__init__.py`, '');
  fs.writeFileSync(`${WORK}/addons/bm_probe/tests/__init__.py`, 'from . import test_probe\n');
  fs.writeFileSync(`${WORK}/addons/bm_probe/tests/test_probe.py`, 'from odoo.tests.common import TransactionCase\n\n\nclass TestProbe(TransactionCase):\n    def test_ok(self):\n        self.assertTrue(True)\n');
  fs.writeFileSync(`${WORK}/modules_to_install.txt`, 'bm_probe\n');
  fs.writeFileSync(`${WORK}/.gitignore`, '__pycache__/\n*.pyc\n');
  git(ROOT, 'init', '-q', '-b', 'main', 'work');
  git(WORK, 'add', '-A');
  git(WORK, 'commit', '-q', '-m', 'probe');
  git(WORK, 'checkout', '-q', '-b', 'feature');
  fs.appendFileSync(`${WORK}/addons/bm_probe/tests/test_probe.py`, '\n    def test_bad(self):\n        self.assertEqual(1, 2)\n');
  git(WORK, 'commit', '-q', '-am', 'failing test');
  git(ROOT, 'clone', '-q', '--bare', 'work', 'origin.git');
  return `file:///${ROOT}/origin.git`;
}

async function waitBranches(win, names) {
  for (let i = 0; i < 60; i++) {
    const found = await Promise.all(names.map((n) => branch(win, ID, n)));
    if (found.every(Boolean)) return found;
    await pause();
  }
  throw new Error('ветки не появились');
}

const go = async (win, hash) => {
  await win.evaluate((h) => (location.hash = h), hash);
  await win.waitForTimeout(2000);
};
const rows = (win, prefix) => win.locator(`[data-testid^="${prefix}"]`).count();

async function run(win) {
  const url = makeOrigin();
  const c = await bm(win, 'repo.clone', { url, mirror: true, shallow: false });
  check('копия репозитория', (await waitJob(win, c.jobId)).status === 'success');
  const d = await bm(win, 'projects.detect', { mirror: c.dir, url });
  const cfg = structuredClone(d.proposals.odoo);
  Object.assign(cfg, { id: ID, name: 'Builds & audit check' });
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

  // Three builds: feature with a failing test (running), feature with failBuild (failed), main (running, no tests).
  await waitJob(win, (await bm(win, 'builds.rebuild', { branchId: devBr.id })).jobId);
  await bm(win, 'branches.setOverrides', { branchId: devBr.id, overrides: { tests: { failBuild: true } } });
  await waitJob(win, (await bm(win, 'builds.rebuild', { branchId: devBr.id })).jobId);
  await waitJob(win, (await bm(win, 'builds.rebuild', { branchId: prodBr.id })).jobId);
  const all = await bm(win, 'builds.list', { projectId: ID, limit: 50 });
  check('три сборки', all.total === 3, String(all.total));

  // A settings change with a diff: fetch interval.
  const cur = await bm(win, 'projects.get', { projectId: ID });
  const doc = YAML.parseDocument(cur.yaml);
  doc.setIn(['repo', 'fetchIntervalMin'], 17);
  await bm(win, 'projects.update', { projectId: ID, yaml: doc.toString() });

  // Builds page: filters in the URL, served by Core.
  await go(win, `#/projects/${ID}/builds`);
  check('Builds: все сборки', (await rows(win, 'builds-row-')) === 3);
  await go(win, `#/projects/${ID}/builds?tests=failed`);
  check('Builds: тесты упали', (await rows(win, 'builds-row-')) === 2);
  await go(win, `#/projects/${ID}/builds?status=failed&branch=${devBr.id}`);
  check('Builds: ветка + статус failed', (await rows(win, 'builds-row-')) === 1);
  await go(win, `#/projects/${ID}/builds?stage=production`);
  check('Builds: стадия Production', (await rows(win, 'builds-row-')) === 1);
  const today = new Date();
  const day = (off) => {
    const x = new Date(today);
    x.setDate(x.getDate() + off);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  };
  await go(win, `#/projects/${ID}/builds?to=${day(-1)}`);
  check('Builds: до вчера — пусто', (await rows(win, 'builds-row-')) === 0 && (await win.isVisible('text=Нет сборок по этому фильтру.')));
  await go(win, `#/projects/${ID}/builds?from=${day(0)}&tests=failed`);
  await shot(win, 'builds-filters');
  check('Builds: сегодня + тесты упали', (await rows(win, 'builds-row-')) === 2);

  // Audit Logs.
  await go(win, `#/projects/${ID}/audit`);
  const total = (await bm(win, 'audit.list', { projectId: ID })).total;
  check('Audit: записи проекта', total >= 5, String(total));
  await go(win, `#/projects/${ID}/audit?action=build.`);
  const buildRows = await rows(win, 'audit-row-');
  const apiBuild = (await bm(win, 'audit.list', { projectId: ID, action: 'build.' })).total;
  check('Audit: группа build.*', buildRows === apiBuild && buildRows >= 3, `${buildRows} / ${apiBuild}`);
  await go(win, `#/projects/${ID}/audit?result=error`);
  check('Audit: только ошибки', (await rows(win, 'audit-row-')) >= 1 && (await win.locator('text=build.failed').count()) >= 1);
  await go(win, `#/projects/${ID}/audit?action=settings.update`);
  const first = win.locator('[data-testid^="audit-row-"]').first();
  await first.click();
  await win.waitForTimeout(800);
  const details = await win.locator('[data-testid^="audit-details-"]').first().textContent();
  check('Audit: дифф настроек', /\+ .*fetchIntervalMin: 17/.test(details ?? '') && /- .*fetchIntervalMin/.test(details ?? ''), (details ?? '').slice(0, 200));
  check('Audit: пароль в диффе скрыт', !(details ?? '').includes(cfg.postgres.password) || !cfg.postgres.password);
  await shot(win, 'audit-diff');
  await go(win, `#/projects/${ID}/audit?q=${encodeURIComponent('ТЕСТЫ НЕ ПРОШЛИ')}`);
  await win.fill('input[placeholder="Объект или параметры"]', 'ТЕСТЫ НЕ ПРОШЛИ');
  await win.waitForTimeout(1500);
  check('Audit: поиск по параметрам без учёта регистра', (await rows(win, 'audit-row-')) >= 1);
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
