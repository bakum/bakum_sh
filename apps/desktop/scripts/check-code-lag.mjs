// Code lag (D47) on a tiny «Odoo in Docker» project (own Postgres, odoo:19.0): after a deploy to production the
// Development branch that copies the mirror but lacks the new commit gets «behind-source» (with the module) instead
// of «mirror newer», a Rebuild from the copy writes a warning into build.log, merging main into the branch clears it;
// a branch fully merged into main and left behind gets «merged-behind».
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { launch, bm, shot } from './pw.mjs';
import { SANDBOX, waitJob, waitJobs, branch, lastBuild } from './sandbox.mjs';

const ID = 'bmlag';
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
const MANIFEST = `${WORK}/addons/bm_probe/__manifest__.py`;
const manifest = (v) => `{'name': 'BM probe', 'version': '19.0.${v}', 'depends': ['base'], 'license': 'LGPL-3'}\n`;

function makeOrigin() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(`${WORK}/addons/bm_probe`, { recursive: true });
  fs.mkdirSync(`${WORK}/addons/bm_other`, { recursive: true });
  fs.writeFileSync(MANIFEST, manifest('1.0.0'));
  fs.writeFileSync(`${WORK}/addons/bm_probe/__init__.py`, '');
  fs.writeFileSync(`${WORK}/addons/bm_other/__manifest__.py`, `{'name': 'BM other', 'version': '19.0.1.0.0', 'depends': ['base'], 'license': 'LGPL-3'}\n`);
  fs.writeFileSync(`${WORK}/addons/bm_other/__init__.py`, '');
  fs.writeFileSync(`${WORK}/modules_to_install.txt`, 'bm_probe\nbm_other\n');
  fs.writeFileSync(`${WORK}/.gitignore`, '__pycache__/\n*.pyc\n');
  git(ROOT, 'init', '-q', '-b', 'main', 'work');
  git(WORK, 'add', '-A');
  git(WORK, 'commit', '-q', '-m', 'base');
  git(WORK, 'branch', 'old');
  git(WORK, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(`${WORK}/addons/bm_other/README.md`, 'feature work\n');
  git(WORK, 'add', '-A');
  git(WORK, 'commit', '-q', '-m', 'feature work');
  git(WORK, 'checkout', '-q', 'main');
  git(ROOT, 'clone', '-q', '--bare', 'work', 'origin.git');
  git(WORK, 'remote', 'add', 'origin', `${ROOT}/origin.git`);
  return `file:///${ROOT}/origin.git`;
}

async function waitFor(what, fn, timeoutMs = 120000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`не дождались: ${what}`);
    await pause();
  }
}

const kinds = (b) => b.badges.map((x) => x.kind);
const copyOverrides = { database: 'copy:production', tests: { mode: 'none' }, onNewCommit: 'none' };

async function run(win) {
  const url = makeOrigin();
  const c = await bm(win, 'repo.clone', { url, mirror: true, shallow: false });
  check('копия репозитория', (await waitJob(win, c.jobId)).status === 'success');
  const d = await bm(win, 'projects.detect', { mirror: c.dir, url });
  const cfg = structuredClone(d.proposals.odoo);
  Object.assign(cfg, { id: ID, name: 'Code lag check' });
  cfg.naming.db = `bm_${ID}_{slug_}_{build}`;
  cfg.naming.host = `{slug}.${ID}.localhost`;
  cfg.runtime.network = `bm-${ID}`;
  cfg.postgres.protectedContainers = [`bm-${ID}-db`];
  cfg.repo.worktreesDir = `${ROOT}/worktrees`;
  cfg.runtime.filestore.hostDir = `${ROOT}/filestore`;
  cfg.production.backups.dir = null;
  await bm(win, 'projects.create', { yaml: YAML.stringify(cfg) });
  await waitJobs(win, ID, 900000);
  const [prodBr, feat, old] = await waitFor('ветки', async () => {
    const f = await Promise.all(['main', 'feature', 'old'].map((n) => branch(win, ID, n)));
    return f.every(Boolean) ? f : null;
  });
  for (const b of [feat, old]) await bm(win, 'branches.setOverrides', { branchId: b.id, overrides: copyOverrides });

  // 1. Production, then feature from its copy: the branch contains the mirror's code.
  await waitJob(win, (await bm(win, 'builds.rebuild', { branchId: prodBr.id })).jobId);
  const fj = await waitJob(win, (await bm(win, 'builds.rebuild', { branchId: feat.id })).jobId);
  check('feature собрана из копии', fj.status === 'success', fj.error ?? '');
  await pause(3000);
  const f1 = await bm(win, 'branches.get', { branchId: feat.id });
  check('до выката: отставания нет', f1.codeLag === null && !kinds(f1).includes('behind-source'), JSON.stringify(f1.badges));

  // 2. Deploy to production: main changes bm_probe; production updates (onNewCommit: update).
  fs.writeFileSync(MANIFEST, manifest('1.0.1'));
  git(WORK, 'commit', '-q', '-am', 'prod: bump bm_probe');
  git(WORK, 'push', '-q', 'origin', 'main');
  await bm(win, 'git.fetch', { projectId: ID });
  await waitJobs(win, ID);
  const prod2 = await lastBuild(win, prodBr.id);
  check('прод обновлён', prod2.kind === 'update' && prod2.status === 'running', `${prod2.kind} ${prod2.status}`);
  const f2 = await waitFor('бейдж отставания', async () => {
    const v = await bm(win, 'branches.get', { branchId: feat.id });
    return v.codeLag ? v : null;
  });
  check('feature: отстаёт на 1 коммит, модуль bm_probe', f2.codeLag.behind === 1 && f2.codeLag.ahead === 1 && f2.codeLag.modules.join() === 'bm_probe', JSON.stringify(f2.codeLag));
  check('бейдж behind-source вместо mirror-newer', kinds(f2).includes('behind-source') && !kinds(f2).includes('mirror-newer'), kinds(f2).join());
  const text = f2.badges.find((x) => x.kind === 'behind-source').text;
  check('текст: отставание, риск Rebuild с модулем, merge', /нет 1 коммита из main/.test(text) && /Rebuild рискован: недостающий коммит меняет модули bm_probe/.test(text) && /git merge origin\/main/.test(text), text);
  const o2 = await waitFor('бейдж влитой ветки', async () => {
    const v = await bm(win, 'branches.get', { branchId: old.id });
    return v.codeLag ? v : null;
  });
  // old = the base commit: main has one commit more (the deploy), old has none of its own.
  check('old: целиком влита и отстала', kinds(o2).includes('merged-behind') && o2.codeLag.ahead === 0 && o2.codeLag.behind === 1, JSON.stringify(o2.codeLag));
  const oText = o2.badges.find((x) => x.kind === 'merged-behind').text;
  check('текст влитой: удалить или fast-forward', /целиком влита в main/.test(oText) && /git merge --ff-only origin\/main/.test(oText), oText);
  await win.evaluate(([pid, id]) => (location.hash = `#/projects/${pid}/branches/${id}/history`), [ID, feat.id]);
  await win.waitForTimeout(2500);
  check('сайдбар: ↓1 у feature', (await win.textContent('[data-testid="lag-feature"]'))?.includes('↓1'));
  check('страница ветки: баннер', await win.isVisible('[data-testid="badge-behind-source"]'));
  await shot(win, 'code-lag');

  // 3. A Rebuild anyway (the RPC has no confirmation): the warning is in build.log.
  await waitJob(win, (await bm(win, 'builds.rebuild', { branchId: feat.id })).jobId);
  const fb = await lastBuild(win, feat.id);
  const log = (await bm(win, 'logs.read', { buildId: fb.id, kind: 'build', tail: 3000 })).lines.join('\n');
  check('build.log: предупреждение об отставании', /\[warn\] ветка отстаёт на 1 коммит от кода, которым обновлена БД-источник/.test(log) && /bm_probe/.test(log));

  // 4. main merged into feature and pushed: the lag is gone.
  git(WORK, 'checkout', '-q', 'feature');
  git(WORK, 'merge', '-q', '--no-edit', 'main');
  git(WORK, 'push', '-q', 'origin', 'feature');
  git(WORK, 'checkout', '-q', 'main');
  await bm(win, 'git.fetch', { projectId: ID });
  await waitJobs(win, ID);
  const f4 = await waitFor('отставание исчезло', async () => {
    const v = await bm(win, 'branches.get', { branchId: feat.id });
    return !v.codeLag && !kinds(v).includes('behind-source') ? v : null;
  });
  check('после merge бейджа нет', !!f4, kinds(f4).join());
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
