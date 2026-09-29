// Final acceptance on the real DEMZ project, part C — criteria 4, 12, 6, 7, 8.
// Criterion 5 needs a new commit pushed to GitHub origin/19.0-demz-crm (the app never pushes): see docs/acceptance.md.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { launch, shot, bm } from './pw.mjs';
import { waitJobs, branch, lastBuild } from './sandbox.mjs';
import { httpReq, httpStatus, odooGet, odooLogin, odooRpc } from './odoo-http.mjs';
import { Dap } from './dap.mjs';

const PID = 'demz';
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const step = (s) => console.log(`\n=== ${s}`);
const pgq = async (db, sql, params = []) => {
  const c = new pg.Client({ host: 'localhost', port: 5433, user: 'odoo', password: 'odoo', database: db });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
};
async function waitBuild(win, b) {
  const t0 = Date.now();
  await waitJobs(win, PID, 3 * 3600000);
  const x = await lastBuild(win, b.id);
  console.log(`${b.name} #${x.number} ${x.status} ${x.kind} ${x.dbName} ${Math.round((Date.now() - t0) / 1000)}s`);
  for (const s of x.steps) console.log('  ', s.name, s.status, (s.note ?? '').slice(0, 200));
  if (x.errorMessage) console.log('  error:', x.errorMessage);
  return x;
}
const only = process.argv.slice(2);
const want = (n) => !only.length || only.includes(n);

const { app, win } = await launch({ BM_PROFILE: '' });

if (want('4')) {
  step('criterion 4: 19.0-demz-crm from a copy of the prod mirror');
  const crm = await branch(win, PID, '19.0-demz-crm');
  await bm(win, 'builds.rebuild', { branchId: crm.id });
  const b = await waitBuild(win, crm);
  if (b.status === 'running') {
    const img = await pgq(b.dbName, "SELECT res_id, store_fname FROM ir_attachment WHERE res_model = 'product.template' AND res_field = 'image_1920' AND store_fname IS NOT NULL LIMIT 1");
    const cred = await bm(win, 'builds.credentials', { buildId: b.id });
    const s = await odooLogin(b.url, cred.login, cred.password);
    const r = img[0] ? await odooGet(b.url, `/web/image/product.template/${img[0].res_id}/image_128`, s.session) : null;
    const sel = await odooGet(b.url, '/web/database/selector');
    console.log('login', s.status, '| product image', r?.status, r?.type, '| selector DBs:', [...new Set([...sel.body.toString().matchAll(/o19_[a-z0-9_]+/g)].map((m) => m[0]))]);
  } else {
    const log = fs.readFileSync(b.logPath, 'utf8').split('\n');
    console.log('build log excerpt:\n' + log.filter((l) => /ParseError|не існує|недійсна|Error:|CRITICAL/.test(l)).slice(0, 6).join('\n'));
  }
  const repo = 'E:/demz-odoo-19/repositories/demz-odoo';
  console.log(`19.0-demz-crm vs 19.0: ahead ${git(repo, 'rev-list', '--count', 'origin/19.0..origin/19.0-demz-crm')}, behind ${git(repo, 'rev-list', '--count', 'origin/19.0-demz-crm..origin/19.0')}`);
  await win.evaluate((id) => (location.hash = `#/projects/demz/branches/${id}/history`), crm.id);
  await win.waitForTimeout(2500);
  await shot(win, 'C4-crm');
}

if (want('12')) {
  step('criterion 12: the branch open in the main checkout, tracking: local');
  const repo = 'E:/demz-odoo-19/repositories/demz-odoo';
  const current = git(repo, 'symbolic-ref', '--short', 'HEAD');
  console.log('main checkout is on', current);
  // Leftovers of the earlier run (perevertum was no longer in the main checkout): drop its builds.
  const perev = await branch(win, PID, '19.0-demz-perevertum');
  for (const x of (await bm(win, 'builds.list', { branchId: perev.id })).items.filter((x) => x.status !== 'dropped')) {
    if (x.status === 'queued' || x.status === 'building') continue;
    await bm(win, 'builds.drop', { buildId: x.id });
  }
  await waitJobs(win, PID, 600000);
  const b = await branch(win, PID, current);
  const eff = await bm(win, 'config.effective', { branchId: b.id });
  const ov = eff.branchOverrides;
  await bm(win, 'branches.setOverrides', { branchId: b.id, overrides: { ...ov, tracking: 'local' } });
  const dbsBefore = (await pgq('postgres', "SELECT datname FROM pg_database WHERE datname LIKE 'o19_br_%'")).map((r) => r.datname);
  const buildsBefore = (await bm(win, 'builds.list', { branchId: b.id })).total;
  try {
    await bm(win, 'builds.rebuild', { branchId: b.id });
    console.log('UNEXPECTED: queued');
  } catch (e) {
    console.log('error:', String(e.message).replace(/^.*Error: /, ''));
  }
  const dbsAfter = (await pgq('postgres', "SELECT datname FROM pg_database WHERE datname LIKE 'o19_br_%'")).map((r) => r.datname);
  console.log('builds before/after:', buildsBefore, (await bm(win, 'builds.list', { branchId: b.id })).total, '| new DBs:', dbsAfter.filter((d) => !dbsBefore.includes(d)));
  console.log(git(repo, 'worktree', 'list'));
  await win.evaluate((id) => (location.hash = `#/projects/demz/branches/${id}/history`), b.id);
  await win.waitForTimeout(2000);
  await win.waitForTimeout(2000);
  await shot(win, 'C12-dialog');
  await bm(win, 'branches.setOverrides', { branchId: b.id, overrides: ov });
}

let t999;
if (want('6')) {
  step('criterion 6: Fork 19.0-demz-test999 from 19.0');
  const prod = await branch(win, PID, '19.0');
  t999 = await branch(win, PID, '19.0-demz-test999');
  if (!t999) t999 = (await bm(win, 'branches.fork', { branchId: prod.id, name: 'test999', push: false })).branch;
  console.log('fork:', t999.name, t999.stage, t999.slug);
  const b1 = await waitBuild(win, t999);
  const info = await win.evaluate(() => window.bm.desktop.info());
  console.log('notification:', fs.readFileSync(path.join(info.localDir, 'logs', 'main.log'), 'utf8').split('\n').filter((l) => l.includes('"notification"')).pop());
  const wt = (await bm(win, 'branches.get', { branchId: t999.id })).worktreePath;
  const installed = new Set((await pgq(b1.dbName, "SELECT name FROM ir_module_module WHERE state = 'installed'")).map((r) => r.name));
  const modDir = git(wt, 'ls-tree', '-r', '--name-only', 'HEAD')
    .split('\n')
    .filter((f) => f.startsWith('demzua/') && f.endsWith('/__manifest__.py'))
    .map((f) => f.slice(0, -'/__manifest__.py'.length))
    .find((d) => installed.has(d.split('/').pop()));
  const mod = modDir.split('/').pop();
  fs.writeFileSync(
    path.join(wt, modDir, 'bm_ping.py'),
    ['from odoo import http', '', '', 'class BmPing(http.Controller):', "    @http.route('/bm/ping', type='http', auth='public')", '    def bm_ping(self, **kw):', "        marker = 'bm-ping-ok'", '        return marker', ''].join('\n'),
  );
  fs.appendFileSync(path.join(wt, modDir, '__init__.py'), '\nfrom . import bm_ping\n');
  const before = await pgq(b1.dbName, 'SELECT write_date FROM ir_module_module WHERE name = $1', [mod]);
  const other = await pgq(b1.dbName, "SELECT name, write_date FROM ir_module_module WHERE state = 'installed' AND name <> $1 ORDER BY write_date DESC LIMIT 1", [mod]);
  git(wt, 'add', '-A');
  git(wt, '-c', 'user.name=bm-check', '-c', 'user.email=bm@example.invalid', 'commit', '-q', '-m', `bm acceptance: /bm/ping in ${mod}`);
  console.log(`committed ${git(wt, 'rev-parse', '--short', 'HEAD')} in ${wt} (module ${modDir})`);
  let b2 = b1;
  for (let i = 0; i < 40 && b2.id === b1.id; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    b2 = await lastBuild(win, t999.id);
  }
  b2 = await waitBuild(win, t999);
  const after = await pgq(b2.dbName, 'SELECT write_date FROM ir_module_module WHERE name = $1', [mod]);
  const otherAfter = await pgq(b2.dbName, 'SELECT write_date FROM ir_module_module WHERE name = $1', [other[0].name]);
  console.log(`same DB ${b2.dbName === b1.dbName}; ${mod}: ${before[0].write_date.toISOString()} → ${after[0].write_date.toISOString()}; ${other[0].name} unchanged ${other[0].write_date.getTime() === otherAfter[0].write_date.getTime()}`);
  const crm = await branch(win, PID, '19.0-demz-crm');
  const pre = await branch(win, PID, '19.0');
  console.log('/bm/ping test999:', await httpStatus(`${b2.url}/bm/ping`));
  console.log('/bm/ping prod   :', await httpStatus(`${pre.url}/bm/ping`));
  console.log('/bm/ping crm    :', crm.url ? await httpStatus(`${crm.url}/bm/ping`) : 'no live build');
  console.log('/bm/ping :8019  :', await httpStatus('http://localhost:8019/bm/ping'));
  await win.evaluate((id) => (location.hash = `#/projects/demz/branches/${id}/history`), t999.id);
  await win.waitForTimeout(2000);
  for (const action of ['Скрыть', 'Показать']) {
    if (action === 'Показать') await win.click('[data-testid="toggle-hidden"]');
    await win.click(`[data-testid="branch-19.0-demz-test999"]`, { button: 'right' });
    await win.click(`text=${action}`);
    await win.waitForTimeout(1000);
    await shot(win, `C6-${action === 'Скрыть' ? 'hidden' : 'shown'}`);
    const now = await bm(win, 'branches.get', { branchId: t999.id });
    console.log(`${action} → hidden=${now.hidden}; in sidebar: ${await win.isVisible('[data-testid="branch-19.0-demz-test999"]')}`);
  }
}

if (want('7')) {
  step('criterion 7: two builds in one browser');
  const names = ['19.0', '19.0-demz-test999'];
  const ss = [];
  for (const n of names) {
    const b = await branch(win, PID, n);
    const cred = await bm(win, 'builds.credentials', { buildId: b.liveBuild.id });
    const s = await odooLogin(b.url, cred.login, cred.password);
    const sc = s.setCookie.find((c) => c.startsWith('session_id=')) ?? '';
    console.log(`${n} ${b.url}: login ${s.status}; cookie attrs: ${sc.split(';').slice(1).join(';')}`);
    ss.push({ n, url: b.url, cookie: s.session });
  }
  for (let round = 1; round <= 2; round++) {
    for (const s of ss) {
      const j = await odooRpc(s.url, '/web/session/get_session_info', s.cookie);
      console.log(`round ${round} ${s.n}: uid=${j.result?.uid} db=${j.result?.db}`);
    }
  }
}

if (want('8')) {
  step('criterion 8: debugpy attach with the generated launch.json');
  t999 ??= await branch(win, PID, '19.0-demz-test999');
  const b = await bm(win, 'branches.get', { branchId: t999.id });
  const lj = JSON.parse((await bm(win, 'builds.launchJson', { buildId: b.liveBuild.id })).json).configurations[0];
  console.log('launch.json:', JSON.stringify(lj));
  const modFile = git(b.worktreePath, 'ls-files').split('\n').find((f) => f.endsWith('/bm_ping.py'));
  const file = `${lj.pathMappings[0].localRoot}/${modFile}`.replace(/\//g, '\\');
  const dap = new Dap(lj.connect.port);
  await dap.connect();
  await dap.send('initialize', { adapterID: 'debugpy', clientID: 'vscode', pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true });
  const attach = dap.send('attach', { ...lj, clientOS: 'windows' });
  await dap.waitEvent('initialized', 30000);
  const bp = await dap.send('setBreakpoints', { source: { path: file }, breakpoints: [{ line: 7 }] });
  console.log('breakpoint:', JSON.stringify(bp.body.breakpoints[0]));
  await dap.send('configurationDone');
  await attach;
  const req = httpReq(`${b.url}/bm/ping`).then((r) => `${r.status} ${r.body.toString()}`);
  const stopped = await dap.waitEvent('stopped', 60000).catch((e) => ({ error: e.message }));
  if (stopped.body) {
    const st = await dap.send('stackTrace', { threadId: stopped.body.threadId, levels: 1 });
    const top = st.body.stackFrames[0];
    console.log(`STOPPED (${stopped.body.reason}) at ${top.source?.path}:${top.line} in ${top.name}`);
    await dap.send('continue', { threadId: stopped.body.threadId });
  } else console.log('not stopped:', stopped.error);
  console.log('HTTP after continue:', await req);
  await dap.send('disconnect', { terminateDebuggee: false });
  dap.close();
  console.log('Editor:', JSON.stringify(await bm(win, 'shell.open', { branchId: t999.id, target: 'editor' })), '→', b.worktreePath);
  const info = await win.evaluate(() => window.bm.desktop.info());
  console.log(fs.readFileSync(path.join(info.localDir, 'logs', 'core.log'), 'utf8').split('\n').filter((l) => l.includes('editor opened')).pop());
}
await app.close();
