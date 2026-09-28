// Final acceptance, part D — criteria 10, 13, 11, 9, 15 (real profile, DEMZ + a second project).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import YAML from 'yaml';
import pg from 'pg';
import { launch, shot, bm, cleanEnv, electronExe, appDir } from './pw.mjs';
import { waitJobs, branch, lastBuild } from './sandbox.mjs';
import { httpReq, httpStatus } from './odoo-http.mjs';

const REAL = { BM_PROFILE: '' };
const step = (s) => console.log(`\n=== ${s}`);
const only = process.argv.slice(2);
const want = (n) => !only.length || only.includes(n);
const dbs = async (like) => {
  const c = new pg.Client({ host: 'localhost', port: 5433, user: 'odoo', password: 'odoo', database: 'postgres' });
  await c.connect();
  const r = await c.query('SELECT datname FROM pg_database WHERE datname LIKE $1 ORDER BY 1', [like]);
  await c.end();
  return r.rows.map((x) => x.datname);
};
async function waitAll(win, t = 3 * 3600000) {
  const until = Date.now() + t;
  while ((await bm(win, 'jobs.list', { active: true })).length && Date.now() < until) await new Promise((r) => setTimeout(r, 3000));
}
const showBuild = (x) => console.log(`#${x.number} ${x.status} ${x.kind} ${x.dbName} debugPort ${x.debugPort} ${x.url ?? ''} ${x.errorMessage ?? ''}`);

let { app, win } = await launch(REAL);

{
  // Free 19.0-demz-perevertum for the user's main checkout: its local worktree was created during part C.
  const p = await branch(win, 'demz', '19.0-demz-perevertum');
  if (p?.worktreePath) {
    await bm(win, 'branches.delete', { branchId: p.id, confirmSlug: p.slug, deleteLocal: false, deleteRemote: false, forceDirty: false });
    await waitAll(win, 600000);
    await bm(win, 'branches.add', { projectId: 'demz', name: '19.0-demz-perevertum' });
    console.log('perevertum worktree removed, branch re-added:', execFileSync('git', ['-C', 'E:/demz-odoo-19/repositories/demz-odoo', 'worktree', 'list'], { encoding: 'utf8' }));
  }
}

if (want('10')) {
  step('criterion 10: a second project on another repository');
  const d = await bm(win, 'projects.detect', { path: 'E:/bakum_sh/tmp/second-repo' });
  console.log('detected:', JSON.stringify({ remote: d.remote, branches: d.branches, modules: d.moduleCount, roots: d.moduleRoots, list: d.modulesToInstall, preset: d.suggestedPreset, warnings: d.warnings.length }));
  if (!(await bm(win, 'projects.list')).some((p) => p.id === 'second')) {
    const cfg = structuredClone(d.proposals.generic);
    cfg.id = 'second';
    cfg.name = 'Second project';
    cfg.runtime.image = 'odoo:19';
    cfg.runtime.network = 'demz-odoo-19_default';
    cfg.runtime.repoMount = '/mnt/second';
    cfg.runtime.command = cfg.runtime.command.map((a) => a.replace('/mnt/repositories/second-repo', '/mnt/second'));
    cfg.postgres = { ...cfg.postgres, host: 'localhost', port: 5433, internalHost: 'db', user: 'odoo', password: 'odoo', protectedDbs: ['postgres', 'o19_test'], protectedContainers: ['odoo19', 'odoo19-db'] };
    cfg.runtime.env = { PGPASSWORD: 'odoo' };
    cfg.stages.development = { ...cfg.stages.development, withDemo: false, install: { list: ['bm_hello'] } };
    cfg.autoAddBranches = 'all';
    await bm(win, 'projects.create', { yaml: YAML.stringify(cfg) });
    await waitAll(win, 120000);
  }
  const fx = await branch(win, 'second', 'feature-x');
  console.log('second project branches:', JSON.stringify((await bm(win, 'branches.list', { projectId: 'second' })).development.map((b) => b.name)));
  await bm(win, 'builds.rebuild', { branchId: fx.id });
  // While it builds, the DEMZ builds keep serving.
  await new Promise((r) => setTimeout(r, 5000));
  const prod = await branch(win, 'demz', '19.0');
  console.log('during second build — DEMZ prod:', await httpStatus(`${prod.url}/web/login`));
  await waitAll(win);
  const b = await lastBuild(win, fx.id);
  showBuild(b);
  for (const s of b.steps) console.log('  ', s.name, s.status, (s.note ?? '').slice(0, 120));
  console.log('/bm/hello second:', await httpStatus(`${b.url}/bm/hello`));
  const t999 = await branch(win, 'demz', '19.0-demz-test999');
  for (const x of [prod, t999, await branch(win, 'second', 'feature-x')]) {
    const lb = x.liveBuild ?? (await lastBuild(win, x.id));
    console.log(`${x.projectId}/${x.name}: db ${lb.dbName}, host ${lb.url}, compose ${execFileSync('docker', ['ps', '--filter', `label=bm.build=${lb.id}`, '--format', '{{.Names}}'], { encoding: 'utf8' }).trim()}, debug ${lb.debugPort}, HTTP ${await httpStatus(`${lb.url}/web/login`)}`);
  }
}

if (want('13')) {
  step('criterion 13: close the window during a build');
  const fx = await branch(win, 'second', 'feature-x');
  await bm(win, 'builds.rebuild', { branchId: fx.id });
  await new Promise((r) => setTimeout(r, 3000));
  const st = () => win.evaluate(() => window.bm.desktop.info().then((i) => ({ sleepBlocked: i.sleepBlocked, windowVisible: i.windowVisible })));
  console.log('building:', JSON.stringify(await st()));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await new Promise((r) => setTimeout(r, 1500));
  console.log('window closed:', JSON.stringify(await st()), 'process alive:', !app.process().killed);
  await waitAll(win);
  showBuild(await lastBuild(win, fx.id));
  await new Promise((r) => setTimeout(r, 1500));
  console.log('after:', JSON.stringify(await st()));
  const info = await win.evaluate(() => window.bm.desktop.info());
  console.log(fs.readFileSync(path.join(info.localDir, 'logs', 'main.log'), 'utf8').split('\n').filter((l) => /notification|sleep/.test(l)).slice(-3).join('\n'));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
}

if (want('11')) {
  step('criterion 11: kill the app during a build');
  const t999 = await branch(win, 'demz', '19.0-demz-test999');
  const live = t999.liveBuild;
  console.log('live before:', `#${live.number} ${live.status}`);
  await bm(win, 'builds.rebuild', { branchId: t999.id });
  let b;
  for (;;) {
    b = await lastBuild(win, t999.id);
    const r = b.steps.find((s) => s.status === 'running');
    if ((r && ['filestore', 'local-tweaks', 'modules'].includes(r.name)) || b.status === 'failed' || b.status === 'running') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`taskkill during #${b.number}, step ${b.steps.find((s) => s.status === 'running')?.name}`);
  execFileSync('taskkill', ['/F', '/T', '/PID', String(app.process().pid)]);
  await new Promise((r) => setTimeout(r, 3000));
  ({ app, win } = await launch(REAL));
  await new Promise((r) => setTimeout(r, 8000));
  const jobs = await bm(win, 'jobs.list', { projectId: 'demz', limit: 3 });
  console.log('jobs:', jobs.map((j) => `${j.type}#${j.id}:${j.status}`).join(', '));
  const failed = await bm(win, 'builds.get', { buildId: b.id });
  console.log(`build #${failed.number}: ${failed.status} — ${failed.errorMessage}`);
  const liveNow = (await bm(win, 'branches.get', { branchId: t999.id })).liveBuild;
  console.log(`live: #${liveNow.number} ${liveNow.status} container ${liveNow.containerState} HTTP ${await httpStatus(`${liveNow.url}/web/login`)}`);
  const fsDir = `E:/demz-odoo-19/data/filestore/${failed.dbName}`;
  console.log('failed build resources: DB', (await dbs(failed.dbName)).length > 0, '| filestore', fs.existsSync(fsDir));
  await bm(win, 'builds.drop', { buildId: failed.id });
  await waitAll(win, 600000);
  console.log(`after «Отбросить»: ${(await bm(win, 'builds.get', { buildId: failed.id })).status}; DB ${(await dbs(failed.dbName)).length > 0}; filestore ${fs.existsSync(fsDir)}; containers «${execFileSync('docker', ['ps', '-a', '--filter', `label=bm.build=${failed.id}`, '--format', '{{.Names}}'], { encoding: 'utf8' }).trim()}»`);
}

if (want('9')) {
  step('criterion 9: levels and «конфигурация изменилась»');
  const state = await bm(win, 'system.state');
  const file = path.join(state.configDir, 'projects', 'demz.yaml');
  const edit = (fn) => {
    const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
    fn(doc);
    fs.writeFileSync(file, doc.toString());
  };
  const t999 = await branch(win, 'demz', '19.0-demz-test999');
  const field = async (p) => (await bm(win, 'config.effective', { branchId: t999.id })).fields.find((f) => f.path === p);
  edit((d) => d.setIn(['stages', 'development', 'idleStopHours'], 6));
  await new Promise((r) => setTimeout(r, 2500));
  console.log('YAML edited by hand:', JSON.stringify(await field('idleStopHours')));
  const ov = (await bm(win, 'config.effective', { branchId: t999.id })).branchOverrides;
  await bm(win, 'branches.setOverrides', { branchId: t999.id, overrides: { ...ov, idleStopHours: 3 } });
  console.log('branch override   :', JSON.stringify(await field('idleStopHours')));
  await win.evaluate((id) => (location.hash = `#/projects/demz/branches/${id}/settings`), t999.id);
  await win.waitForTimeout(2500);
  await win.locator('[data-field="idleStopHours"]').scrollIntoViewIfNeeded();
  await shot(win, 'D9-levels');
  const live = t999.liveBuild;
  const cid = () => execFileSync('docker', ['ps', '--filter', `label=bm.build=${live.id}`, '--format', '{{.ID}}'], { encoding: 'utf8' }).trim();
  const before = cid();
  edit((d) => d.setIn(['runtime', 'env', 'BM_ACCEPTANCE'], '1'));
  await new Promise((r) => setTimeout(r, 2500));
  const b1 = await bm(win, 'branches.get', { branchId: t999.id });
  const prod = await bm(win, 'branches.get', { branchId: (await branch(win, 'demz', '19.0')).id });
  console.log('env changed → test999 configChanged', b1.liveBuild.configChanged, '| prod configChanged', prod.liveBuild.configChanged);
  await win.evaluate((id) => (location.hash = `#/projects/demz/branches/${id}/history`), t999.id);
  await win.waitForTimeout(2000);
  await shot(win, 'D9-config-changed');
  await bm(win, 'builds.action', { buildId: live.id, action: 'apply-config' });
  await waitAll(win, 900000);
  const b2 = await bm(win, 'branches.get', { branchId: t999.id });
  console.log(`«Применить»: container ${before} → ${cid()}, build #${b2.liveBuild.number} (same ${b2.liveBuild.id === live.id}), DB ${b2.liveBuild.dbName}, configChanged ${b2.liveBuild.configChanged}, /bm/ping ${await httpStatus(`${b2.url}/bm/ping`)}`);
  // Restore the settings and apply them to every live build.
  edit((d) => {
    d.deleteIn(['runtime', 'env', 'BM_ACCEPTANCE']);
    d.deleteIn(['stages', 'development', 'idleStopHours']);
  });
  await bm(win, 'branches.setOverrides', { branchId: t999.id, overrides: ov });
  await new Promise((r) => setTimeout(r, 2500));
  for (const x of [...(await bm(win, 'branches.list', { projectId: 'demz' })).production, ...(await bm(win, 'branches.list', { projectId: 'demz' })).development]) {
    if (x.liveBuild?.configChanged) await bm(win, 'builds.action', { buildId: x.liveBuild.id, action: 'apply-config' });
  }
  await waitAll(win, 900000);
  console.log('settings restored and applied');
}
await app.close();

if (want('15')) {
  step('criterion 15: listening sockets of the app (normal launch)');
  const child = spawn(electronExe, [appDir], { env: cleanEnv(REAL), stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 15000));
  const pids = new Set(execFileSync('tasklist', ['/FI', 'IMAGENAME eq electron.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean).map((l) => l.split('","')[1]));
  const lines = execFileSync('netstat', ['-ano'], { encoding: 'utf8' }).split(/\r?\n/).filter((l) => /LISTENING/.test(l) && pids.has(l.trim().split(/\s+/).pop()));
  console.log('electron PIDs:', [...pids].join(', '), '| listening:', lines.length ? '\n' + lines.join('\n') : 'none');
  console.log('ports of Docker (Traefik, debug):', execFileSync('docker', ['ps', '--filter', 'label=bm.project', '--format', '{{.Names}} {{.Ports}}'], { encoding: 'utf8' }).trim().replace(/\n/g, ' | '), '|', execFileSync('docker', ['ps', '--filter', 'name=bm-traefik', '--format', '{{.Ports}}'], { encoding: 'utf8' }).trim());
  execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)]);
}
