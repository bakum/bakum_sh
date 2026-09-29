// {addonsPath} (D48) on a tiny «Odoo in Docker» project (own Postgres, odoo:19.0): the addons path of a build comes
// from its own code. `feature` adds a new module folder addons/domain2 (like a new demzua/<domain> in DEMZ): its build
// installs the module from there, the Production build of `main` does not list the folder; the manual -u of the
// Tools tab (a one-off run) finds the module too.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { launch, bm } from './pw.mjs';
import { SANDBOX, waitJob, waitJobs, branch, lastBuild } from './sandbox.mjs';

const ID = 'bmaddons';
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

function writeModule(dir, name) {
  fs.mkdirSync(`${WORK}/${dir}/${name}`, { recursive: true });
  fs.writeFileSync(
    `${WORK}/${dir}/${name}/__manifest__.py`,
    `{'name': '${name}', 'version': '${VERSION}.1.0.0', 'depends': ['base'], 'license': 'LGPL-3', 'installable': True}\n`,
  );
  fs.writeFileSync(`${WORK}/${dir}/${name}/__init__.py`, '');
}

/** Bare repository: main — addons/bm_probe; feature — adds addons/domain2/bm_extra to the modules to install. */
function makeOrigin() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  writeModule('addons', 'bm_probe');
  fs.writeFileSync(`${WORK}/modules_to_install.txt`, 'bm_probe\n');
  fs.writeFileSync(`${WORK}/.gitignore`, '__pycache__/\n*.pyc\n');
  git(ROOT, 'init', '-q', '-b', 'main', 'work');
  git(WORK, 'add', '-A');
  git(WORK, 'commit', '-q', '-m', 'probe');
  git(WORK, 'checkout', '-q', '-b', 'feature');
  writeModule('addons/domain2', 'bm_extra');
  fs.writeFileSync(`${WORK}/modules_to_install.txt`, 'bm_probe\nbm_extra\n');
  git(WORK, 'add', '-A');
  git(WORK, 'commit', '-q', '-m', 'new module folder');
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

async function rebuild(win, br) {
  const j = await waitJob(win, (await bm(win, 'builds.rebuild', { branchId: br.id })).jobId);
  return { job: j, build: await lastBuild(win, br.id) };
}

/** --addons-path of the running build container. */
function containerAddons(buildId) {
  const name = docker('ps', '--filter', `label=bm.build=${buildId}`, '--filter', 'label=com.docker.compose.service=odoo', '--format', '{{.Names}}');
  const cmd = JSON.parse(docker('inspect', '-f', '{{json .Config.Cmd}}', name));
  return (cmd.find((a) => a.startsWith('--addons-path=')) ?? '').slice('--addons-path='.length).split(',');
}

async function run(win) {
  const url = makeOrigin();
  const c = await bm(win, 'repo.clone', { url, mirror: true, shallow: false });
  const cj = await waitJob(win, c.jobId);
  check('копия репозитория', cj.status === 'success', cj.error ?? '');
  const d = await bm(win, 'projects.detect', { mirror: c.dir, url });
  const cfg = structuredClone(d.proposals.odoo);
  check('пресет: --addons-path с {addonsPath}', cfg.runtime.command.some((a) => a.startsWith('--addons-path=') && a.endsWith(',{addonsPath}')), cfg.runtime.command.join(' '));
  cfg.id = ID;
  cfg.name = 'Addons path check';
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
  const mount = cfg.runtime.repoMount;

  // 1. Production (main): only the folder that exists in main.
  const rp = await rebuild(win, prodBr);
  check('Production собрана', rp.job.status === 'success' && rp.build.status === 'running', rp.job.error ?? rp.build.errorMessage ?? '');
  const prodAddons = containerAddons(rp.build.id);
  check('Production: addons из кода main', prodAddons.includes(`${mount}/addons`) && !prodAddons.includes(`${mount}/addons/domain2`), prodAddons.join(','));

  // 2. feature: the new folder is on the path, its module is installed.
  const rd = await rebuild(win, devBr);
  check('feature собрана', rd.job.status === 'success' && rd.build.status === 'running', rd.job.error ?? rd.build.errorMessage ?? '');
  const devAddons = containerAddons(rd.build.id);
  check('feature: новая папка в addons_path', devAddons.includes(`${mount}/addons/domain2`) && devAddons.includes(`${mount}/addons`), devAddons.join(','));
  check('feature: bm_extra установлен', sql(rd.build.dbName, "SELECT state FROM ir_module_module WHERE name='bm_extra'") === 'installed');

  // 3. Tools → «Модули вручную»: -u bm_extra is a one-off run with the same addons path.
  const mj = await waitJob(win, (await bm(win, 'builds.modulesAction', { buildId: rd.build.id, install: [], update: ['bm_extra'] })).jobId);
  check('-u bm_extra из вкладки Инструменты', mj.status === 'success', mj.error ?? '');
  const log = await bm(win, 'jobs.log', { jobId: mj.id, tail: 400 });
  const line = log.lines.find((l) => l.includes('$ docker compose run')) ?? '';
  check('разовый запуск получил --addons-path', line.includes(`${mount}/addons/domain2`), line);
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
