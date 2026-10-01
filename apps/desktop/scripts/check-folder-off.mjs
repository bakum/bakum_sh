// D64: the worktree a live build runs is put on the build's commit. feat is built from GitHub (worktree on F1), then
// from the user's folder with an unpushed commit F2 (the app's worktree stays on F1). The folder is switched off:
// «Применить» is refused while F2 is not on GitHub, the container stays as it was; after push + fetch it puts the
// worktree on F2 and the container sees F2's code. A worktree moved to another commit gets the red badge, whose
// «Применить» (and Restart) put it back.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import YAML from 'yaml';
import { launch, bm, shot } from './pw.mjs';
import { SANDBOX, waitJob, waitJobs, branch, lastBuild } from './sandbox.mjs';

const ID = 'bmfoff';
const VERSION = '19.0';
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).trim();
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=bm', '-c', 'user.email=bm@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
const pause = (ms = 2000) => new Promise((r) => setTimeout(r, ms));

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
  fs.writeFileSync(`${WORK}/addons/bm_probe/f1.py`, '# f1\n');
  git(WORK, 'add', '-A');
  git(WORK, 'commit', '-q', '-m', 'f1');
  git(ROOT, 'clone', '-q', '--bare', 'work', 'origin.git');
  git(ROOT, 'clone', '-q', '-b', 'feat', 'origin.git', 'clone');
  return `file:///${ORIGIN}`;
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

const containerOf = (build) => docker('ps', '-a', '--filter', `label=bm.project=${ID}`, '--filter', `label=bm.build=${build.id}`, '--format', '{{.ID}} {{.State}}');
const inContainer = (build, file) => {
  const id = containerOf(build).split(' ')[0];
  try {
    docker('exec', id, 'test', '-f', file);
    return true;
  } catch {
    return false;
  }
};

async function run(win) {
  const url = makeOrigin();
  const c = await bm(win, 'repo.clone', { url, mirror: true, shallow: false });
  check('копия репозитория', (await waitJob(win, c.jobId)).status === 'success');
  const d = await bm(win, 'projects.detect', { mirror: c.dir, url });
  const cfg = structuredClone(d.proposals.odoo);
  cfg.id = ID;
  cfg.name = 'Folder off check';
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
  const probe = `${cfg.runtime.repoMount}/addons/bm_probe`;

  // 1. From GitHub: the worktree is created on F1.
  let feat = (await branch(win, ID, 'feat')) ?? (await bm(win, 'branches.add', { projectId: ID, name: 'feat', stage: 'development', build: false }));
  const f1 = git(CLONE, 'rev-parse', 'HEAD');
  const j1 = await waitJob(win, (await bm(win, 'builds.rebuild', { branchId: feat.id })).jobId, 1800000);
  feat = await bm(win, 'branches.get', { branchId: feat.id });
  const wt = feat.worktreePath;
  check('сборка feat с GitHub', j1.status === 'success' && !!wt && git(wt, 'rev-parse', 'HEAD') === f1, j1.error ?? '');

  // 2. From the folder, then an unpushed commit F2 there: the build is updated to F2, the worktree stays on F1.
  const eff = await bm(win, 'config.effective', { branchId: feat.id });
  const base = { ...eff.branchOverrides };
  await bm(win, 'branches.setOverrides', { branchId: feat.id, overrides: { ...base, folder: CLONE } });
  const ja = await waitJob(win, (await bm(win, 'builds.action', { buildId: (await lastBuild(win, feat.id)).id, action: 'apply-config' })).jobId);
  check('«Из моей папки» применено', ja.status === 'success', ja.error ?? '');
  const total0 = (await bm(win, 'builds.list', { branchId: feat.id, limit: 1 })).total;
  fs.writeFileSync(`${CLONE}/addons/bm_probe/f2.py`, '# f2\n');
  git(CLONE, 'add', '-A');
  git(CLONE, 'commit', '-q', '-m', 'f2');
  const f2 = git(CLONE, 'rev-parse', 'HEAD');
  await waitFor(async () => (await bm(win, 'builds.list', { branchId: feat.id, limit: 1 })).total > total0, 'сборка по коммиту в папке');
  await waitJobs(win, ID, 1800000);
  let live = await lastBuild(win, feat.id);
  check('сборка из папки на F2', live.status === 'running' && live.commitSha === f2, `${live.status} ${live.commitSha?.slice(0, 7)} ${live.errorMessage ?? ''}`);
  check('worktree остался на F1 (как в журнале)', git(wt, 'rev-parse', 'HEAD') === f1);

  // 3. Folder switched off while F2 is only in the folder: «Применить» refuses, nothing changes.
  await bm(win, 'branches.setOverrides', { branchId: feat.id, overrides: base });
  const container0 = containerOf(live);
  const jr = await waitJob(win, (await bm(win, 'builds.action', { buildId: live.id, action: 'apply-config' })).jobId);
  check('«Применить» без F2 на GitHub отклонено', jr.status === 'failed' && /нет в копии репозитория/.test(jr.error ?? ''), jr.error ?? jr.status);
  check('контейнер не тронут, worktree на F1', containerOf(live) === container0 && git(wt, 'rev-parse', 'HEAD') === f1);

  // 4. Pushed and fetched: «Применить» puts the worktree on F2, the container sees F2's code.
  git(CLONE, 'push', '-q', 'origin', 'feat');
  for (const id of (await bm(win, 'git.fetch', { projectId: ID })).jobs) await waitJob(win, id);
  const jp = await waitJob(win, (await bm(win, 'builds.action', { buildId: live.id, action: 'apply-config' })).jobId);
  check('«Применить» после push', jp.status === 'success', jp.error ?? '');
  check('worktree на коммите сборки F2', git(wt, 'rev-parse', 'HEAD') === f2);
  check('в контейнере код F2', inContainer(live, `${probe}/f2.py`));
  check('fetch не запустил новую сборку', (await lastBuild(win, feat.id)).id === live.id);
  feat = await bm(win, 'branches.get', { branchId: feat.id });
  check('плашек про код нет', !feat.badges.some((x) => x.kind === 'worktree-off-build' || x.kind === 'config-changed'), feat.badges.map((x) => x.kind).join(','));

  // 5. Worktree moved to another commit: the red badge; its «Применить» puts it back. Restart too.
  git(wt, 'checkout', '-q', '--detach', f1);
  await win.evaluate((p) => (location.hash = p), `#/projects/${ID}/branches/${feat.id}/history`);
  const badge = win.getByTestId('badge-worktree-off-build');
  await badge.waitFor({ timeout: 30000 });
  check('красная плашка «код в worktree не совпадает»', (await badge.innerText()).includes(f1.slice(0, 7)));
  await shot(win, 'folder-off-badge');
  const lastJob = async () => Math.max(0, ...(await bm(win, 'jobs.list', { projectId: ID, limit: 5 })).map((x) => x.id));
  const before = await lastJob();
  await badge.getByRole('button', { name: 'Применить' }).click();
  await waitFor(async () => (await lastJob()) > before, 'задача «Применить»');
  await waitJobs(win, ID, 600000);
  check('кнопка плашки вернула worktree на F2', git(wt, 'rev-parse', 'HEAD') === f2);
  await badge.waitFor({ state: 'detached', timeout: 30000 });
  check('плашка ушла', true);
  git(wt, 'checkout', '-q', '--detach', f1);
  const jt = await waitJob(win, (await bm(win, 'builds.action', { buildId: live.id, action: 'restart' })).jobId);
  check('Restart вернул worktree на F2', jt.status === 'success' && git(wt, 'rev-parse', 'HEAD') === f2, jt.error ?? '');
  live = await lastBuild(win, feat.id);
  check('живая сборка та же и работает', live.status === 'running' && live.commitSha === f2);
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
  await shot(win, 'folder-off-fail').catch(() => {});
} finally {
  if ((await bm(win, 'projects.list')).some((p) => p.id === ID)) {
    const j = await waitJob(win, (await bm(win, 'projects.delete', { projectId: ID, confirm: ID })).jobId);
    check(`проект ${ID} удалён`, j.status === 'success', j.error ?? '');
  }
  check('контейнеры других проектов на месте', others() === othersBefore);
  await app.close();
  const own = `${process.env.LOCALAPPDATA}/Odoo Branch Manager/traefik/compose.yml`;
  if (fs.existsSync(own)) docker('compose', '-p', 'bm-traefik', '-f', own, 'up', '-d');
}
console.log(`Итого: ${results.filter(Boolean).length} из ${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
