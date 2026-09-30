// D59: a Development branch built from the user's folder is blocked while another branch is open in that folder. A tiny
// «Odoo in Docker» project; the user's clone has branch feat open, feat is built from it. Then the clone switches to main
// and commits there: no build starts, every action except Stop is refused (UI, RPC, bm), the running container and
// the live build stay as they were. Back on feat the block lifts itself and a commit updates the build again.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { launch, bm, shot } from './pw.mjs';
import { SANDBOX, waitJob, waitJobs, branch, lastBuild } from './sandbox.mjs';

const ID = 'bmfold';
const VERSION = '19.0';
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=bm', '-c', 'user.email=bm@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
const pause = (ms = 2000) => new Promise((r) => setTimeout(r, ms));
const BIN = path.join(process.env.LOCALAPPDATA, 'Odoo Branch Manager (dev)', 'bin');

const ROOT = `${SANDBOX}/${ID}`;
const WORK = `${ROOT}/work`;
const ORIGIN = `${ROOT}/origin.git`;
const CLONE = `${ROOT}/clone`;

function makeOrigin() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(`${WORK}/addons/bm_probe`, { recursive: true });
  fs.writeFileSync(
    `${WORK}/addons/bm_probe/__manifest__.py`,
    `{'name': 'bm_probe', 'version': '${VERSION}.1.0.0', 'depends': ['base'], 'license': 'LGPL-3', 'installable': True}\n`,
  );
  fs.writeFileSync(`${WORK}/addons/bm_probe/__init__.py`, '');
  fs.writeFileSync(`${WORK}/modules_to_install.txt`, 'bm_probe\n');
  fs.writeFileSync(`${WORK}/.gitignore`, '__pycache__/\n');
  git(ROOT, 'init', '-q', '-b', 'main', 'work');
  git(WORK, 'add', '-A');
  git(WORK, 'commit', '-q', '-m', 'probe');
  git(WORK, 'checkout', '-q', '-b', 'feat');
  fs.writeFileSync(`${WORK}/addons/bm_probe/feat.py`, '# feat\n');
  git(WORK, 'add', '-A');
  git(WORK, 'commit', '-q', '-m', 'feat');
  git(ROOT, 'clone', '-q', '--bare', 'work', 'origin.git');
  git(ROOT, 'clone', '-q', '-b', 'feat', 'origin.git', 'clone');
  return `file:///${ORIGIN}`;
}

function commit(file) {
  fs.writeFileSync(`${CLONE}/addons/bm_probe/${file}`, `# ${file}\n`);
  git(CLONE, 'add', '-A');
  git(CLONE, 'commit', '-q', '-m', file);
  return git(CLONE, 'rev-parse', 'HEAD');
}

async function waitFor(fn, what, timeoutMs = 60000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`не дождались: ${what}`);
    await pause(1000);
  }
}

const settle = (win, method, params) => win.evaluate(([m, p]) => window.bm.settle(m, p), [method, params]);
const containerOf = (build) => docker('ps', '-a', '--filter', `label=bm.project=${ID}`, '--filter', `label=bm.build=${build.id}`, '--format', '{{.ID}} {{.State}}');

async function run(win) {
  const url = makeOrigin();
  const c = await bm(win, 'repo.clone', { url, mirror: true, shallow: false });
  check('копия репозитория', (await waitJob(win, c.jobId)).status === 'success');
  const d = await bm(win, 'projects.detect', { mirror: c.dir, url });
  const cfg = structuredClone(d.proposals.odoo);
  cfg.id = ID;
  cfg.name = 'Folder branch check';
  cfg.naming.db = `bm_${ID}_{slug_}_{build}`;
  cfg.naming.host = `{slug}.${ID}.localhost`;
  cfg.runtime.network = `bm-${ID}`;
  cfg.postgres.protectedContainers = [`bm-${ID}-db`];
  cfg.repo.worktreesDir = `${ROOT}/worktrees`;
  cfg.repo.localFolder = CLONE;
  cfg.repo.fetchIntervalMin = 0;
  cfg.runtime.filestore.hostDir = `${ROOT}/filestore`;
  cfg.production.backups.dir = null;
  cfg.stages.development = { ...cfg.stages.development, database: 'fresh', withDemo: false, onNewCommit: 'update', idleStopHours: 0, tests: { mode: 'none' } };
  await bm(win, 'projects.create', { yaml: YAML.stringify(cfg) });
  await waitJobs(win, ID, 900000);

  let feat = (await branch(win, ID, 'feat')) ?? (await bm(win, 'branches.add', { projectId: ID, name: 'feat', stage: 'development', build: false }));
  const eff = await bm(win, 'config.effective', { branchId: feat.id });
  await bm(win, 'branches.setOverrides', { branchId: feat.id, overrides: { ...eff.branchOverrides, folder: CLONE } });
  const j = await waitJob(win, (await bm(win, 'builds.rebuild', { branchId: feat.id })).jobId, 1800000);
  const live = await lastBuild(win, feat.id);
  check('сборка feat из папки', j.status === 'success' && live.status === 'running', j.error ?? '');
  if (live.status !== 'running') throw new Error('нет живой сборки');
  feat = await bm(win, 'branches.get', { branchId: feat.id });
  check('без блокировки, пока в папке feat', feat.folderBranch === 'feat' && !feat.folderBlocked, `${feat.folderBranch}`);
  const container0 = containerOf(live);
  const total0 = (await bm(win, 'builds.list', { branchId: feat.id, limit: 1 })).total;

  // The IDE switches the folder to another branch, and there is a commit on that branch.
  git(CLONE, 'checkout', '-q', 'main');
  const mainSha = commit('main_only.py');
  feat = await waitFor(async () => {
    const b = await bm(win, 'branches.get', { branchId: feat.id });
    return b.folderBlocked ? b : null;
  }, 'блокировка ветки');
  check('ветка заблокирована: в папке main', feat.folderBranch === 'main' && feat.badges.some((x) => x.kind === 'folder-wrong-branch'));
  check('нет бейджа «несобранные коммиты»', !feat.badges.some((x) => x.kind === 'unbuilt-commits'));
  await pause(8000);
  check('коммит в main не запустил сборку', !(await bm(win, 'jobs.list', { projectId: ID, active: true })).length && (await bm(win, 'builds.list', { branchId: feat.id, limit: 1 })).total === total0);

  await win.evaluate((p) => (location.hash = p), `#/projects/${ID}/branches/${feat.id}/history`);
  await win.getByTestId('badge-folder-wrong-branch').waitFor({ timeout: 30000 });
  check('красная плашка на странице ветки', await win.getByTestId('badge-folder-wrong-branch').isVisible());
  check('Rebuild неактивен', (await win.getByTestId('rebuild').getAttribute('data-disabled')) === 'true');
  check('пометка в списке веток', await win.getByTestId('folder-blocked-feat').isVisible());
  await shot(win, 'folder-branch-blocked');
  await win.getByRole('button', { name: 'Ещё' }).first().click();
  await win.getByTestId('folder-blocked').waitFor();
  const item = (name) => win.getByRole('menuitem', { name, exact: true });
  check('в меню сборки Restart и «Отбросить» неактивны, Stop — нет', (await item('Restart').isDisabled()) && (await item('Отбросить сборку…').isDisabled()) && !(await item('Stop').isDisabled()));
  await shot(win, 'folder-branch-menu');
  await win.keyboard.press('Escape');
  await win.evaluate((p) => (location.hash = p), `#/projects/${ID}/branches/${feat.id}/editor`);
  await win.getByTestId('folder-branch').waitFor();
  check('Editor показывает ветку в папке', (await win.getByTestId('folder-branch').innerText()).includes('main'));
  await shot(win, 'folder-branch-editor');

  const refused = [
    ['builds.rebuild', { branchId: feat.id }],
    ['builds.update', { branchId: feat.id }],
    ['builds.action', { buildId: live.id, action: 'restart' }],
    ['builds.action', { buildId: live.id, action: 'apply-config' }],
    ['builds.modulesAction', { buildId: live.id, install: [], update: ['bm_probe'] }],
    ['builds.testsAction', { buildId: live.id, modules: ['bm_probe'] }],
    ['builds.drop', { buildId: live.id }],
    ['branches.delete', { branchId: feat.id, confirmSlug: feat.slug, deleteRemote: false, forceDirty: false }],
  ];
  for (const [m, p] of refused) {
    const r = await settle(win, m, p);
    check(`${m}${p.action ? ` ${p.action}` : ''} отклонён`, !r.ok && r.error.code === 'FOLDER_WRONG_BRANCH', r.ok ? 'прошёл' : r.error.code);
  }
  const pv = await bm(win, 'branches.deletePreview', { branchId: feat.id });
  check('Delete: причина в превью', !!pv.folderBlocked);
  const cli = spawnSync('cmd.exe', ['/d', '/c', path.join(BIN, 'bm.cmd'), 'restart', 'feat'], { cwd: CLONE, encoding: 'utf8', timeout: 120000 });
  check('bm restart отклонён', cli.status !== 0 && /открыта ветка main/.test(`${cli.stdout}${cli.stderr}`), `код ${cli.status}: ${(cli.stderr || cli.stdout).trim().split('\n').pop()}`);
  check('контейнер и живая сборка не тронуты', containerOf(live) === container0 && (await lastBuild(win, feat.id)).id === live.id, container0);

  const stop = await waitJob(win, (await bm(win, 'builds.action', { buildId: live.id, action: 'stop' })).jobId);
  check('Stop работает', stop.status === 'success', stop.error ?? '');
  const start = await settle(win, 'builds.action', { buildId: live.id, action: 'start' });
  check('Start отклонён', !start.ok && start.error.code === 'FOLDER_WRONG_BRANCH');

  // Back on feat: the block lifts itself; HEAD = the built commit, so nothing is built.
  git(CLONE, 'checkout', '-q', 'feat');
  feat = await waitFor(async () => {
    const b = await bm(win, 'branches.get', { branchId: feat.id });
    return !b.folderBlocked && b.folderBranch === 'feat' ? b : null;
  }, 'снятие блокировки');
  check('блокировка снята', !feat.badges.some((x) => x.kind === 'folder-wrong-branch'));
  await pause(5000);
  check('возврат на feat ничего не собрал', (await bm(win, 'builds.list', { branchId: feat.id, limit: 1 })).total === total0);
  const st = await waitJob(win, (await bm(win, 'builds.action', { buildId: live.id, action: 'start' })).jobId);
  check('Start снова работает', st.status === 'success', st.error ?? '');
  const featSha = commit('feat_more.py');
  await waitFor(async () => (await bm(win, 'builds.list', { branchId: feat.id, limit: 1 })).total > total0, 'сборка по коммиту feat');
  await waitJobs(win, ID, 1800000);
  const upd = await lastBuild(win, feat.id);
  check('коммит в feat обновил сборку', upd.kind === 'update' && upd.status === 'running' && upd.commitSha === featSha, `${upd.kind} ${upd.status} ${upd.errorMessage ?? ''}`);
  check('коммит main в сборку не попал', upd.commitSha !== mainSha);
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
  await run(win);
} catch (err) {
  check('без исключений', false, err.stack ?? err.message);
  await shot(win, 'folder-branch-fail').catch(() => {});
} finally {
  if (fs.existsSync(CLONE)) git(CLONE, 'checkout', '-q', '-f', 'feat');
  if ((await bm(win, 'projects.list')).some((p) => p.id === ID)) {
    const j = await waitJob(win, (await bm(win, 'projects.delete', { projectId: ID, confirm: ID })).jobId);
    check(`проект ${ID} удалён`, j.status === 'success', j.error ?? '');
  }
  check('контейнеры других проектов на месте', others() === othersBefore);
  await app.close();
  const own = path.join(process.env.LOCALAPPDATA, 'Odoo Branch Manager', 'traefik', 'compose.yml');
  if (fs.existsSync(own)) docker('compose', '-p', 'bm-traefik', '-f', own, 'up', '-d');
}
console.log(`Итого: ${results.filter(Boolean).length} из ${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
