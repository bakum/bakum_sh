// D77: a folder branch gets a new module folder (like demzua/terminal in DEMZ) after its build. The branch page shows
// the «Применить» badge; a manual -i of a module from it recreates the server with the new --addons-path, so the
// module's route answers without a Rebuild; Restart does the same for one more folder.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import YAML from 'yaml';
import { launch, bm, shot } from './pw.mjs';
import { SANDBOX, waitJob, waitJobs, branch, lastBuild } from './sandbox.mjs';

const ID = 'bmfoldaddons';
const VERSION = '19.0';
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).trim();
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=bm', '-c', 'user.email=bm@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
const pause = (ms = 2000) => new Promise((r) => setTimeout(r, ms));
const sql = (db, q) => docker('exec', `bm-${ID}-db`, 'psql', '-U', 'odoo', '-d', db, '-Atc', q);

const ROOT = `${SANDBOX}/${ID}`;
const WORK = `${ROOT}/work`;
const CLONE = `${ROOT}/clone`;

function writeModule(base, dir, name, route = false) {
  const m = `${base}/${dir}/${name}`;
  fs.mkdirSync(m, { recursive: true });
  fs.writeFileSync(`${m}/__manifest__.py`, `{'name': '${name}', 'version': '${VERSION}.1.0.0', 'depends': ['base'], 'license': 'LGPL-3', 'installable': True}\n`);
  fs.writeFileSync(`${m}/__init__.py`, route ? 'from . import controllers\n' : '');
  if (route) {
    fs.writeFileSync(
      `${m}/controllers.py`,
      ['from odoo import http', '', '', 'class Probe(http.Controller):', `    @http.route('/${name}', type='http', auth='public')`, '    def ping(self):', `        return '${name}-ok'`, ''].join('\n'),
    );
  }
}

function makeOrigin() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  writeModule(WORK, 'addons', 'bm_probe');
  fs.writeFileSync(`${WORK}/modules_to_install.txt`, 'bm_probe\n');
  fs.writeFileSync(`${WORK}/.gitignore`, '__pycache__/\n*.pyc\n');
  git(ROOT, 'init', '-q', '-b', 'main', 'work');
  git(WORK, 'add', '-A');
  git(WORK, 'commit', '-q', '-m', 'probe');
  git(WORK, 'checkout', '-q', '-b', 'feat');
  git(ROOT, 'clone', '-q', '--bare', 'work', 'origin.git');
  git(ROOT, 'clone', '-q', '-b', 'feat', 'origin.git', 'clone');
  return `file:///${ROOT}/origin.git`;
}

async function waitFor(fn, what, timeoutMs = 180000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`не дождались: ${what}`);
    await pause(2000);
  }
}

const serverOf = (b) => docker('ps', '-a', '--filter', `label=bm.build=${b.id}`, '--filter', 'label=com.docker.compose.oneoff=False', '--format', '{{.ID}}');
const addonsOf = (b) => {
  const cmd = JSON.parse(docker('inspect', '-f', '{{json .Config.Cmd}}', serverOf(b)));
  return (cmd.find((a) => a.startsWith('--addons-path=')) ?? '').slice('--addons-path='.length).split(',');
};
const labelArgs = (b) => docker('inspect', '-f', '{{index .Config.Labels "bm.odoo.args"}}', serverOf(b));
const healthy = (b) => docker('inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{end}}', serverOf(b)) === 'healthy';
const route = (b, path) => {
  try {
    return docker('exec', serverOf(b), 'python3', '-c', `import urllib.request; print(urllib.request.urlopen('http://localhost:8069${path}', timeout=20).read().decode())`);
  } catch (e) {
    return String(e.stderr ?? e.message).split('\n').filter(Boolean).pop();
  }
};
const ADDONS_LINE = /Папки модулей в папке ветки изменились|Папки модулів у папці гілки змінилися|module folders in the branch folder changed/;
const driftBadge = async (brId) => (await bm(win, 'branches.get', { branchId: brId })).badges.find((x) => x.kind === 'config-changed' && /--addons-path/.test(x.text));
const jobLog = async (jobId) => (await bm(win, 'jobs.log', { jobId, tail: 600 })).lines.join('\n');

async function run() {
  const url = makeOrigin();
  const c = await bm(win, 'repo.clone', { url, mirror: true, shallow: false });
  check('копия репозитория', (await waitJob(win, c.jobId)).status === 'success');
  const d = await bm(win, 'projects.detect', { mirror: c.dir, url });
  const cfg = structuredClone(d.proposals.odoo);
  cfg.id = ID;
  cfg.name = 'Folder addons check';
  cfg.naming.db = `bm_${ID}_{slug_}_{build}`;
  cfg.naming.host = `{slug}.${ID}.localhost`;
  cfg.runtime.network = `bm-${ID}`;
  cfg.postgres.protectedContainers = [`bm-${ID}-db`];
  cfg.repo.worktreesDir = `${ROOT}/worktrees`;
  cfg.repo.localFolder = CLONE;
  cfg.repo.fetchIntervalMin = 0;
  cfg.runtime.filestore.hostDir = `${ROOT}/filestore`;
  cfg.production.backups.dir = null;
  cfg.stages.development = { ...cfg.stages.development, database: 'fresh', install: 'my', withDemo: false, idleStopHours: 0, tests: { mode: 'none', failBuild: false } };
  await bm(win, 'projects.create', { yaml: YAML.stringify(cfg) });
  await waitJobs(win, ID, 900000);
  const mount = cfg.runtime.repoMount;

  // 1. feat from the folder: build #1 knows only addons/.
  let feat = (await branch(win, ID, 'feat')) ?? (await bm(win, 'branches.add', { projectId: ID, name: 'feat', stage: 'development', build: false }));
  const eff = await bm(win, 'config.effective', { branchId: feat.id });
  await bm(win, 'branches.setOverrides', { branchId: feat.id, overrides: { ...eff.branchOverrides, folder: CLONE } });
  const j1 = await waitJob(win, (await bm(win, 'builds.rebuild', { branchId: feat.id })).jobId, 1800000);
  const live = await lastBuild(win, feat.id);
  check('сборка #1 из папки', j1.status === 'success' && live.status === 'running', j1.error ?? live.errorMessage ?? '');
  check('#1: addons/domain2 нет в --addons-path', !addonsOf(live).includes(`${mount}/addons/domain2`), addonsOf(live).join(','));
  check('плашки нет', !(await driftBadge(feat.id)));

  // 2. A new module folder in the folder (not committed): the badge with «Применить».
  writeModule(CLONE, 'addons/domain2', 'bm_extra', true);
  check('плашка «папки модулей изменились»', !!(await waitFor(() => driftBadge(feat.id), 'плашка', 30000)));
  await win.evaluate((p) => (location.hash = p), `#/projects/${ID}/branches/${feat.id}/history`);
  await pause(2000);
  await shot(win, 'folder-addons-badge');

  // 3. bm modules -i bm_extra: the server comes back with addons/domain2 and serves the module's route.
  const container1 = serverOf(live);
  const jm = await waitJob(win, (await bm(win, 'builds.modulesAction', { buildId: live.id, install: ['bm_extra'], update: [] })).jobId);
  check('-i bm_extra', jm.status === 'success', jm.error ?? '');
  check('лог задачи: строка о пересоздании', ADDONS_LINE.test(await jobLog(jm.id)));
  check('контейнер пересоздан', serverOf(live) !== container1, `${container1} → ${serverOf(live)}`);
  check('сервер: addons/domain2 в --addons-path', addonsOf(live).includes(`${mount}/addons/domain2`), addonsOf(live).join(','));
  check('label bm.odoo.args с addons/domain2', labelArgs(live).includes(`${mount}/addons/domain2`), labelArgs(live));
  check('bm_extra установлен', sql(live.dbName, "SELECT state FROM ir_module_module WHERE name='bm_extra'") === 'installed');
  await waitFor(() => healthy(live), 'healthy после -i', 300000);
  const r1 = route(live, '/bm_extra');
  check('маршрут /bm_extra отвечает', r1 === 'bm_extra-ok', r1);
  check('плашка ушла', !(await driftBadge(feat.id)));

  // 4. One more folder, then Restart: recreated with it as well.
  writeModule(CLONE, 'addons/domain3', 'bm_more');
  await waitFor(() => driftBadge(feat.id), 'плашка перед Restart', 30000);
  const container2 = serverOf(live);
  const jr = await waitJob(win, (await bm(win, 'builds.action', { buildId: live.id, action: 'restart' })).jobId);
  check('Restart', jr.status === 'success', jr.error ?? '');
  check('Restart: строка о пересоздании', ADDONS_LINE.test(await jobLog(jr.id)));
  check('Restart: контейнер пересоздан с addons/domain3', serverOf(live) !== container2 && addonsOf(live).includes(`${mount}/addons/domain3`), addonsOf(live).join(','));
  await waitFor(() => healthy(live), 'healthy после Restart', 300000);

  // 5. Nothing changed: Restart only restarts.
  const container3 = serverOf(live);
  const jr2 = await waitJob(win, (await bm(win, 'builds.action', { buildId: live.id, action: 'restart' })).jobId);
  check('Restart без изменений не пересоздаёт', jr2.status === 'success' && serverOf(live) === container3 && !ADDONS_LINE.test(await jobLog(jr2.id)));
  check('БД сборки та же', sql(live.dbName, "SELECT state FROM ir_module_module WHERE name='bm_extra'") === 'installed');
}

const others = () => docker('ps', '-a', '--format', '{{.Names}}').split('\n').filter((n) => n && !n.startsWith(`bm-${ID}-`)).sort().join(',');
const othersBefore = others();
const { app, win } = await launch();
win.setDefaultTimeout(60000);
try {
  const state = await bm(win, 'system.state');
  if (state.firstRun) await bm(win, 'system.completeFirstRun', {});
  if ((await bm(win, 'projects.list')).some((p) => p.id === ID)) {
    const j = await waitJob(win, (await bm(win, 'projects.delete', { projectId: ID, confirm: ID })).jobId);
    console.log(`старый проект ${ID} удалён: ${j.status}`);
  }
  await run();
} catch (err) {
  check('без исключений', false, err.stack ?? err.message);
  await shot(win, 'folder-addons-fail').catch(() => {});
} finally {
  if ((await bm(win, 'projects.list')).some((p) => p.id === ID)) {
    const j = await waitJob(win, (await bm(win, 'projects.delete', { projectId: ID, confirm: ID })).jobId);
    check(`проект ${ID} удалён`, j.status === 'success', j.error ?? '');
  }
  check('контейнеры других проектов на месте', others() === othersBefore);
  await app.close();
  // The dev profile rewrote the shared bm-traefik with its own networks: the default profile's compose is put back.
  const own = `${process.env.LOCALAPPDATA}/Odoo Branch Manager/traefik/compose.yml`;
  if (fs.existsSync(own)) docker('compose', '-p', 'bm-traefik', '-f', own, 'up', '-d');
}
console.log(`Итого: ${results.filter(Boolean).length} из ${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
