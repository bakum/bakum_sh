// Monitor and lifecycle (spec 8.3, 8.9, D45) on a tiny «Odoo in Docker» project (own Postgres, odoo:19.0): requests
// through Traefik reach the Monitor tab and the branch activity; CPU / RAM are sampled; Traefik runs with a bounded log;
// idleStopHours stops the build, dropAfterDays only warns (the build stays). BM_LIFECYCLE_TICK_MS makes it minutes.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { launch, bm, shot } from './pw.mjs';
import { SANDBOX, waitJob, waitJobs, branch, lastBuild } from './sandbox.mjs';
import { httpReq } from './odoo-http.mjs';

const ID = 'bmmon';
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

function makeOrigin() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(`${WORK}/addons/bm_probe`, { recursive: true });
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

async function waitFor(what, fn, timeoutMs = 180000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`не дождались: ${what}`);
    await pause(3000);
  }
}

async function setStage(win, patch) {
  const cur = await bm(win, 'projects.get', { projectId: ID });
  const doc = YAML.parseDocument(cur.yaml);
  for (const [k, v] of Object.entries(patch)) doc.setIn(['stages', 'production', k], v);
  await bm(win, 'projects.update', { projectId: ID, yaml: doc.toString() });
}

async function run(win) {
  const url = makeOrigin();
  const c = await bm(win, 'repo.clone', { url, mirror: true, shallow: false });
  check('копия репозитория', (await waitJob(win, c.jobId)).status === 'success');
  const d = await bm(win, 'projects.detect', { mirror: c.dir, url });
  const cfg = structuredClone(d.proposals.odoo);
  Object.assign(cfg, { id: ID, name: 'Monitor check' });
  cfg.naming.db = `bm_${ID}_{slug_}_{build}`;
  cfg.naming.host = `{slug}.${ID}.localhost`;
  cfg.runtime.network = `bm-${ID}`;
  cfg.postgres.protectedContainers = [`bm-${ID}-db`];
  cfg.repo.worktreesDir = `${ROOT}/worktrees`;
  cfg.runtime.filestore.hostDir = `${ROOT}/filestore`;
  cfg.production.backups.dir = null;
  await bm(win, 'projects.create', { yaml: YAML.stringify(cfg) });
  await waitJobs(win, ID, 900000);
  const prodBr = await waitFor('ветка main', () => branch(win, ID, 'main'), 120000);
  const pj = await waitJob(win, (await bm(win, 'builds.rebuild', { branchId: prodBr.id })).jobId);
  const prod = await lastBuild(win, prodBr.id);
  check('Production собрана', pj.status === 'success' && prod.status === 'running', prod.errorMessage ?? '');

  // 1. Traefik: recreated once with a bounded log.
  const tl = JSON.parse(docker('inspect', '-f', '{{json .HostConfig.LogConfig}}', 'bm-traefik'));
  check('Traefik: лог ограничен', tl.Config?.['max-size'] === '20m', JSON.stringify(tl));

  // 2. Requests → Monitor and the branch activity.
  for (let i = 0; i < 12; i++) await httpReq(`${prod.url}/web/login`).catch(() => null);
  await httpReq(`${prod.url}/websocket`).catch(() => null);
  const m = await waitFor('запросы в Monitor', async () => {
    const v = await bm(win, 'monitor.get', { buildId: prod.id });
    return v.requests.reduce((a, r) => a + r.count, 0) >= 12 && v.resources.length > 0 ? v : null;
  }, 120000).catch(async (err) => {
    const v = await bm(win, 'monitor.get', { buildId: prod.id });
    const lines = docker('logs', 'bm-traefik', '--tail', '200').split('\n').filter((l) => l.includes(`bm-${ID}-prod`)).length;
    throw new Error(`${err.message}: monitor=${JSON.stringify({ requests: v.requests, resources: v.resources.length })}, строк Traefik с роутером: ${lines}`);
  });
  const total = m.requests.reduce((a, r) => a + r.count, 0);
  check('Monitor: запросы посчитаны (websocket — нет)', total === 12, String(total));
  check('Monitor: CPU/RAM замерены', m.resources.length > 0 && m.resources[0].memMb > 0, JSON.stringify(m.resources[0]));
  check('Monitor: размеры БД и filestore', (m.dbSizeBytes ?? 0) > 0 && m.filestoreBytes !== null, `${m.dbSizeBytes} / ${m.filestoreBytes}`);
  check('последний заход записан', !!m.lastActiveAt && Date.now() - new Date(m.lastActiveAt).getTime() < 180000, m.lastActiveAt ?? '');
  await win.evaluate(([pid, id]) => (location.hash = `#/projects/${pid}/branches/${id}/monitor`), [ID, prodBr.id]);
  await win.waitForTimeout(3000);
  check('вкладка Monitor показывает графики', (await win.locator('svg[aria-label^="CPU"]').count()) === 1 && (await win.locator('svg[aria-label^="Запросы"]').count()) === 1);
  await shot(win, 'monitor');

  // 3. dropAfterDays ≈ 40 s: a warning, the build stays.
  await setStage(win, { dropAfterDays: 0.0005 });
  await waitFor('audit build.expired', async () => (await bm(win, 'audit.list', { projectId: ID, action: 'build.expired' })).total > 0);
  const still = await lastBuild(win, prodBr.id);
  check('dropAfterDays: напоминание, сборка на месте', still.id === prod.id && still.status === 'running' && still.isLive, still.status);
  check('History: срок хранения истёк', !!still.dropAt && new Date(still.dropAt).getTime() <= Date.now(), still.dropAt ?? '');
  await setStage(win, { dropAfterDays: 0 });

  // 4. idleStopHours ≈ 36 s: the build is stopped.
  await setStage(win, { idleStopHours: 0.01 });
  const stopped = await waitFor('остановка без активности', async () => {
    const b = await lastBuild(win, prodBr.id);
    return b.status === 'stopped' ? b : null;
  });
  check('idleStopHours: сборка остановлена', stopped.id === prod.id && stopped.isLive);
  check('аудит build.idle-stop', (await bm(win, 'audit.list', { projectId: ID, action: 'build.idle-stop' })).total >= 1);
  await setStage(win, { idleStopHours: 0 });
}

const { app, win } = await launch({ BM_LIFECYCLE_TICK_MS: '10000' });
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
