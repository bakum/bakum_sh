// GitHub avatars in History (D65) on a tiny «Odoo in Docker» project: the head commit is authored with octocat's
// noreply email, so its build shows octocat's avatar loaded from avatars.githubusercontent.com (CSP allows it). Then
// the emails are stripped from the registry, as in builds recorded before D65, and Core fills them in on the next start.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { launch, bm, shot } from './pw.mjs';
import { SANDBOX, waitJob, waitJobs, branch } from './sandbox.mjs';

const ID = 'bmavatar';
const OCTOCAT = '583231+octocat@users.noreply.github.com';
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const pause = (ms = 2000) => new Promise((r) => setTimeout(r, ms));
const registry = path.join(process.env.LOCALAPPDATA, 'Odoo Branch Manager (dev)', 'registry.sqlite');

const ROOT = `${SANDBOX}/${ID}`;
const WORK = `${ROOT}/work`;
const ORIGIN = `${ROOT}/origin.git`;

function makeOrigin() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(`${WORK}/addons/bm_probe`, { recursive: true });
  fs.writeFileSync(
    `${WORK}/addons/bm_probe/__manifest__.py`,
    "{'name': 'bm_probe', 'version': '19.0.1.0.0', 'depends': ['base'], 'license': 'LGPL-3', 'installable': True}\n",
  );
  fs.writeFileSync(`${WORK}/addons/bm_probe/__init__.py`, '');
  git(ROOT, 'init', '-q', '-b', 'main', 'work');
  git(WORK, 'add', '-A');
  git(WORK, '-c', 'user.name=Ann', '-c', 'user.email=ann@example.com', 'commit', '-q', '-m', 'probe');
  git(WORK, '-c', 'user.name=The Octocat', '-c', `user.email=${OCTOCAT}`, 'commit', '-q', '--allow-empty', '-m', 'by octocat');
  git(ROOT, 'clone', '-q', '--bare', 'work', 'origin.git');
  return `file:///${ORIGIN}`;
}

async function waitBranch(win, name, timeoutMs = 120000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const b = await branch(win, ID, name);
    if (b) return b;
    if (Date.now() > until) throw new Error(`ветка ${name} не появилась`);
    await pause();
  }
}

/** The avatar of the newest build in History: its src and the loaded image width (0 — not loaded). */
async function avatar(win, main) {
  await win.evaluate((p) => (location.hash = p), `#/projects/${ID}/branches/${main.id}/history`);
  await win.getByTestId('history-header').waitFor({ timeout: 30000 });
  const img = win.locator('.mantine-Timeline-itemBullet img').first();
  await img.waitFor({ timeout: 30000 });
  await win.waitForFunction((el) => el.complete, await img.elementHandle(), { timeout: 30000 });
  return { src: await img.getAttribute('src'), width: await img.evaluate((el) => el.naturalWidth) };
}

async function setup(win) {
  const url = makeOrigin();
  const c = await bm(win, 'repo.clone', { url, mirror: true, shallow: false });
  check('копия репозитория', (await waitJob(win, c.jobId)).status === 'success');
  const d = await bm(win, 'projects.detect', { mirror: c.dir, url });
  const cfg = structuredClone(d.proposals.odoo);
  cfg.id = ID;
  cfg.name = 'Avatars check';
  cfg.naming.db = `bm_${ID}_{slug_}_{build}`;
  cfg.naming.host = `{slug}.${ID}.localhost`;
  cfg.runtime.network = `bm-${ID}`;
  cfg.postgres.protectedContainers = [`bm-${ID}-db`];
  cfg.repo.worktreesDir = `${ROOT}/worktrees`;
  cfg.repo.fetchIntervalMin = 0;
  cfg.runtime.filestore.hostDir = `${ROOT}/filestore`;
  cfg.production.backups.dir = null;
  await bm(win, 'projects.create', { yaml: YAML.stringify(cfg) });
  await waitJobs(win, ID, 900000);
  const main = await waitBranch(win, 'main');
  if (!(await bm(win, 'builds.list', { branchId: main.id, offset: 0, limit: 1 })).total) {
    check('Rebuild', (await waitJob(win, (await bm(win, 'builds.rebuild', { branchId: main.id })).jobId)).status === 'success');
  }
  const b = (await bm(win, 'builds.list', { branchId: main.id, offset: 0, limit: 1 })).items[0];
  check('сборка записала email автора', b?.commits[0]?.email === OCTOCAT, JSON.stringify(b?.commits));
  const a = await avatar(win, main);
  check('аватар octocat загружен', a.src === 'https://avatars.githubusercontent.com/u/583231?s=56' && a.width > 0, JSON.stringify(a));
  await shot(win, 'avatars-history');
  return main;
}

async function backfilled(win, main) {
  const until = Date.now() + 60000;
  for (;;) {
    const b = (await bm(win, 'builds.list', { branchId: main.id, offset: 0, limit: 1 })).items[0];
    if (b?.commits[0]?.email !== undefined || Date.now() > until) return b;
    await pause(1000);
  }
}

// Commits of the project's builds as recorded before D65: without the email.
const STRIP = [
  'import json, sqlite3, sys',
  'con = sqlite3.connect(sys.argv[1])',
  'rows = con.execute("SELECT id, commits FROM builds WHERE project_id = ?", (sys.argv[2],)).fetchall()',
  'for bid, commits in rows:',
  '    old = [{k: v for k, v in c.items() if k != "email"} for c in json.loads(commits)]',
  '    con.execute("UPDATE builds SET commits = ? WHERE id = ?", (json.dumps(old), bid))',
  'con.commit()',
].join('\n');

const others = () => docker('ps', '-a', '--format', '{{.Names}}').split('\n').filter((n) => n && !n.startsWith(`bm-${ID}-`)).sort().join(',');
const othersBefore = others();
let { app, win } = await launch();
try {
  const state = await bm(win, 'system.state');
  if (state.firstRun) await bm(win, 'system.completeFirstRun', {});
  // Left over by an interrupted run of this scenario (dev profile only).
  if ((await bm(win, 'projects.list')).some((p) => p.id === ID)) {
    const j = await waitJob(win, (await bm(win, 'projects.delete', { projectId: ID, confirm: ID })).jobId);
    console.log(`старый проект ${ID} удалён: ${j.status}`);
  }
  const main = await setup(win);

  await app.close();
  execFileSync('python', ['-c', STRIP, registry, ID]);
  ({ app, win } = await launch());
  const b = await backfilled(win, main);
  check('email старой сборки дописан при старте', b?.commits[0]?.email === OCTOCAT, JSON.stringify(b?.commits));
  const a = await avatar(win, main);
  check('аватар после дозаполнения', a.width > 0, JSON.stringify(a));
} catch (err) {
  check('без исключений', false, err.stack ?? err.message);
  await shot(win, 'avatars-fail').catch(() => {});
} finally {
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
