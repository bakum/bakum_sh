// runtime.build (D46) on a tiny «Odoo in Docker» project (own Postgres, odoo:19.0): the app refuses to tag over an
// image it did not build (odoo:19.0 is left untouched), builds its own tag from a Dockerfile, the build runs on it,
// a Dockerfile edit marks the live build «конфигурация изменилась», «Применить» rebuilds the image and recreates the
// container, deleting the project removes the image.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { launch, bm, shot } from './pw.mjs';
import { SANDBOX, waitJob, waitJobs, branch, lastBuild } from './sandbox.mjs';

const ID = 'bmimg';
const TAG = `bm-${ID}-odoo:latest`;
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const tryDocker = (...args) => {
  try {
    return docker(...args);
  } catch {
    return null;
  }
};
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=bm', '-c', 'user.email=bm@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
const pause = (ms = 2000) => new Promise((r) => setTimeout(r, ms));
const ROOT = `${SANDBOX}/${ID}`;
const WORK = `${ROOT}/work`;
const IMG = `${ROOT}/image`;
const dockerfile = (v) => `FROM odoo:19.0\nUSER root\nRUN echo ${v} > /etc/bm-version\nUSER odoo\n`;

function makeOrigin() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(`${WORK}/addons/bm_probe`, { recursive: true });
  fs.mkdirSync(IMG, { recursive: true });
  fs.writeFileSync(`${IMG}/Dockerfile`, dockerfile('v1'));
  fs.writeFileSync(`${WORK}/addons/bm_probe/__manifest__.py`, `{'name': 'BM probe', 'version': '19.0.1.0.0', 'depends': ['base'], 'license': 'LGPL-3'}\n`);
  fs.writeFileSync(`${WORK}/addons/bm_probe/__init__.py`, '');
  fs.writeFileSync(`${WORK}/modules_to_install.txt`, 'bm_probe\n');
  fs.writeFileSync(`${WORK}/.gitignore`, '__pycache__/\n*.pyc\n');
  git(ROOT, 'init', '-q', '-b', 'main', 'work');
  git(WORK, 'add', '-A');
  git(WORK, 'commit', '-q', '-m', 'probe');
  git(ROOT, 'clone', '-q', '--bare', 'work', 'origin.git');
  return `file:///${ROOT}/origin.git`;
}

async function setRuntime(win, build, image) {
  const cur = await bm(win, 'projects.get', { projectId: ID });
  const doc = YAML.parseDocument(cur.yaml);
  doc.setIn(['runtime', 'build'], build);
  doc.setIn(['runtime', 'image'], image);
  await bm(win, 'projects.update', { projectId: ID, yaml: doc.toString() });
}

const containerOf = (buildId) =>
  docker('ps', '-a', '--filter', `label=bm.build=${buildId}`, '--filter', 'label=com.docker.compose.oneoff=False', '--format', '{{.Names}}').split('\n')[0];

async function run(win) {
  const odooId = docker('image', 'inspect', '-f', '{{.Id}}', 'odoo:19.0');
  const url = makeOrigin();
  const c = await bm(win, 'repo.clone', { url, mirror: true, shallow: false });
  check('копия репозитория', (await waitJob(win, c.jobId)).status === 'success');
  const d = await bm(win, 'projects.detect', { mirror: c.dir, url });
  const cfg = structuredClone(d.proposals.odoo);
  Object.assign(cfg, { id: ID, name: 'Image build check' });
  cfg.naming.db = `bm_${ID}_{slug_}_{build}`;
  cfg.naming.host = `{slug}.${ID}.localhost`;
  cfg.runtime.network = `bm-${ID}`;
  cfg.postgres.protectedContainers = [`bm-${ID}-db`];
  cfg.repo.worktreesDir = `${ROOT}/worktrees`;
  cfg.runtime.filestore.hostDir = `${ROOT}/filestore`;
  cfg.production.backups.dir = null;
  await bm(win, 'projects.create', { yaml: YAML.stringify(cfg) });
  await waitJobs(win, ID, 900000);
  let prodBr = null;
  for (let i = 0; i < 60 && !prodBr; i++) {
    prodBr = await branch(win, ID, 'main');
    if (!prodBr) await pause();
  }

  // 1. A foreign tag is refused, the image stays as it was.
  await setRuntime(win, { context: IMG, dockerfile: 'Dockerfile' }, 'odoo:19.0');
  const j1 = await waitJob(win, (await bm(win, 'projects.buildImage', { projectId: ID })).jobId);
  check('чужой тег отклонён', j1.status === 'failed' && /не перезапишет/.test(j1.error ?? ''), j1.error ?? j1.status);
  check('odoo:19.0 не изменён', docker('image', 'inspect', '-f', '{{.Id}}', 'odoo:19.0') === odooId);

  // 2. The project's own tag: built with the project label.
  await setRuntime(win, { context: IMG, dockerfile: 'Dockerfile' }, TAG);
  const j2 = await waitJob(win, (await bm(win, 'projects.buildImage', { projectId: ID })).jobId);
  check('образ собран', j2.status === 'success', j2.error ?? '');
  check('метка bm.project', tryDocker('image', 'inspect', '-f', '{{index .Config.Labels "bm.project"}}', TAG) === ID);
  await win.evaluate((pid) => (location.hash = `#/projects/${pid}/settings/runtime`), ID);
  await win.waitForTimeout(2500);
  check('Settings: карточка сборки образа', (await win.textContent('[data-testid="runtime-build"]'))?.includes('включена'));
  await shot(win, 'runtime-build');

  // 3. A build runs on the image.
  const pj = await waitJob(win, (await bm(win, 'builds.rebuild', { branchId: prodBr.id })).jobId);
  const prod = await lastBuild(win, prodBr.id);
  check('сборка на своём образе', pj.status === 'success' && prod.status === 'running', prod.errorMessage ?? '');
  const cname = containerOf(prod.id);
  check('контейнер на образе проекта', docker('inspect', '-f', '{{.Config.Image}}', cname) === TAG);
  check('содержимое образа v1', docker('exec', cname, 'cat', '/etc/bm-version') === 'v1');

  // 4. Dockerfile edit → «конфигурация изменилась» → «Применить».
  fs.writeFileSync(`${IMG}/Dockerfile`, dockerfile('v2'));
  const changed = (await bm(win, 'branches.get', { branchId: prodBr.id })).liveBuild;
  check('правка Dockerfile помечает сборку', changed?.configChanged === true);
  const aj = await waitJob(win, (await bm(win, 'builds.action', { buildId: prod.id, action: 'apply-config' })).jobId);
  check('«Применить» выполнено', aj.status === 'success', aj.error ?? '');
  check('контейнер на новом образе (v2)', docker('exec', containerOf(prod.id), 'cat', '/etc/bm-version') === 'v2');
  check('пометка снята', (await bm(win, 'branches.get', { branchId: prodBr.id })).liveBuild?.configChanged === false);
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
    const pv = await bm(win, 'projects.deletePreview', { projectId: ID }).catch(() => null);
    if (pv) check('диалог удаления называет образ', pv.image === TAG, String(pv.image));
    const j = await waitJob(win, (await bm(win, 'projects.delete', { projectId: ID, confirm: ID })).jobId);
    console.log(`проект ${ID} удалён: ${j.status}`);
    check('образ удалён вместе с проектом', tryDocker('image', 'inspect', TAG) === null);
  }
  await app.close();
  const own = path.join(process.env.LOCALAPPDATA, 'Odoo Branch Manager', 'traefik', 'compose.yml');
  if (fs.existsSync(own)) docker('compose', '-p', 'bm-traefik', '-f', own, 'up', '-d');
}
console.log(`Итого: ${results.filter(Boolean).length} из ${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
