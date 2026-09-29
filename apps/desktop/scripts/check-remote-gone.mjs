// A branch deleted on the remote (D50) on a tiny «Odoo in Docker» project (own Postgres, odoo:19.0): after a fetch
// the built branch `feature` is deleted in the app with its container, database and worktree; the protected branch
// `keep` stays; `feature` pushed again is added back by the rules. No .gitignore: the __pycache__ Odoo writes into the
// worktree must not count as the user's changes.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { launch, bm } from './pw.mjs';
import { SANDBOX, waitJob, waitJobs, branch, lastBuild } from './sandbox.mjs';

const ID = 'bmgone';
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
const ORIGIN = `${ROOT}/origin.git`;

/** Bare repository with main, feature and keep (one module, nothing else). */
function makeOrigin() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(`${WORK}/addons/bm_probe`, { recursive: true });
  fs.writeFileSync(
    `${WORK}/addons/bm_probe/__manifest__.py`,
    `{'name': 'bm_probe', 'version': '${VERSION}.1.0.0', 'depends': ['base'], 'license': 'LGPL-3', 'installable': True}\n`,
  );
  fs.writeFileSync(`${WORK}/addons/bm_probe/__init__.py`, '');
  fs.writeFileSync(`${WORK}/modules_to_install.txt`, 'bm_probe\n');
  git(ROOT, 'init', '-q', '-b', 'main', 'work');
  git(WORK, 'add', '-A');
  git(WORK, 'commit', '-q', '-m', 'probe');
  git(WORK, 'branch', 'feature');
  git(WORK, 'branch', 'keep');
  git(ROOT, 'clone', '-q', '--bare', 'work', 'origin.git');
  return `file:///${ORIGIN}`;
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

async function fetchAndWait(win) {
  const { jobs } = await bm(win, 'git.fetch', { projectId: ID });
  for (const j of jobs) await waitJob(win, j);
  await waitJobs(win, ID, 600000);
  return (await Promise.all(jobs.map((j) => bm(win, 'jobs.log', { jobId: j, tail: 200 })))).flatMap((l) => l.lines);
}

const containersOf = (buildId) => docker('ps', '-a', '--filter', `label=bm.build=${buildId}`, '--format', '{{.Names}}');

async function run(win) {
  const url = makeOrigin();
  const c = await bm(win, 'repo.clone', { url, mirror: true, shallow: false });
  const cj = await waitJob(win, c.jobId);
  check('копия репозитория', cj.status === 'success', cj.error ?? '');
  const d = await bm(win, 'projects.detect', { mirror: c.dir, url });
  const cfg = structuredClone(d.proposals.odoo);
  cfg.id = ID;
  cfg.name = 'Remote gone check';
  cfg.naming.db = `bm_${ID}_{slug_}_{build}`;
  cfg.naming.host = `{slug}.${ID}.localhost`;
  cfg.runtime.network = `bm-${ID}`;
  cfg.postgres.protectedContainers = [`bm-${ID}-db`];
  cfg.repo.worktreesDir = `${ROOT}/worktrees`;
  cfg.repo.fetchIntervalMin = 0;
  cfg.repo.protectedBranches = [...cfg.repo.protectedBranches, 'keep'];
  cfg.runtime.filestore.hostDir = `${ROOT}/filestore`;
  cfg.production.backups.dir = null;
  await bm(win, 'projects.create', { yaml: YAML.stringify(cfg) });
  await waitJobs(win, ID, 900000);
  const [, featBr, keepBr] = await waitBranches(win, ['main', 'feature', 'keep']);

  const bj = await waitJob(win, (await bm(win, 'builds.rebuild', { branchId: featBr.id })).jobId);
  const build = await lastBuild(win, featBr.id);
  check('feature собрана', bj.status === 'success' && build.status === 'running', bj.error ?? build.errorMessage ?? '');
  const wt = (await branch(win, ID, 'feature')).worktreePath;
  check('у feature есть контейнер, БД и worktree', !!containersOf(build.id) && sql('postgres', `SELECT 1 FROM pg_database WHERE datname='${build.dbName}'`) === '1' && fs.existsSync(wt), wt);

  // 1. Both branches are deleted on the remote; a fetch deletes feature and keeps the protected keep.
  git(ORIGIN, 'branch', '-D', 'feature', 'keep');
  const fetchLog = await fetchAndWait(win);
  console.log(fetchLog.filter((l) => /feature|keep|deleting/.test(l)).join('\n'));
  check('feature удалена в приложении', !(await branch(win, ID, 'feature')));
  check('контейнер feature удалён', containersOf(build.id) === '');
  check('БД feature удалена', sql('postgres', `SELECT count(*) FROM pg_database WHERE datname='${build.dbName}'`) === '0', build.dbName);
  check('worktree feature удалён', !fs.existsSync(wt), wt);
  check('защищённая keep осталась', !!(await branch(win, ID, 'keep')));
  check('main осталась', !!(await branch(win, ID, 'main')));
  const audit = await bm(win, 'audit.list', { projectId: ID, action: 'branch.delete' });
  const entry = audit.items.find((a) => a.target === 'feature');
  check('Audit: branch.delete с reason remote-gone', JSON.stringify(entry ?? {}).includes('remote-gone'), JSON.stringify(entry?.params ?? null));

  // 2. A second fetch changes nothing (no duplicate jobs for the kept branch).
  const before = (await bm(win, 'jobs.list', { projectId: ID, limit: 200 })).length;
  await fetchAndWait(win);
  const after = await bm(win, 'jobs.list', { projectId: ID, limit: 200 });
  check('повторный fetch — без новых удалений', after.length === before + 1 && after.every((j) => j.type !== 'delete_branch' || j.branchId !== keepBr.id));

  // 3. feature pushed again: auto-added by the rules (not in «не добавлять автоматически»).
  git(WORK, 'push', '-q', ORIGIN, 'feature');
  await fetchAndWait(win);
  check('пересозданная feature добавлена снова', !!(await branch(win, ID, 'feature')));
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
