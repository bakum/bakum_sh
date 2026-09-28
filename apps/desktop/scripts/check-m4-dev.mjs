// Criteria 6 and 8 in the sandbox:
//  6 — Fork 19.0-demz-test999 from 19.0 → Development, build from a copy of the prod mirror; a module change in the
//      worktree + commit → the live build updates exactly that module (update, DB kept); not visible on the prod
//      mirror, staging or localhost:8019; moving the branch to Staging and back changes the stage and offers Rebuild.
//  8 — attach to debugpy with the generated launch.json → a breakpoint in the worktree file is hit.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { launch, shot, bm } from './pw.mjs';
import { ensureSandbox, waitJobs, branch, lastBuild } from './sandbox.mjs';
import { Dap } from './dap.mjs';
import { httpStatus, httpReq } from './odoo-http.mjs';

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
const httpStatusOld = async (url) => {
  try {
    const r = await fetch(url, { redirect: 'manual' });
    return `${r.status} ${r.status === 200 ? (await r.text()).slice(0, 40) : ''}`.trim();
  } catch (e) {
    return `ERR ${e.cause?.code ?? e.message}`;
  }
};
async function waitBuild(win, pid, b) {
  const t0 = Date.now();
  await waitJobs(win, pid, 3 * 3600000);
  const x = await lastBuild(win, b.id);
  console.log(`#${x.number} ${x.status} ${x.kind} ${x.dbName} ${Math.round((Date.now() - t0) / 1000)}s ${x.errorMessage ?? ''}`);
  for (const s of x.steps) console.log('  ', s.name, s.status, s.note ?? '');
  return x;
}

const { app, win } = await launch();
const pid = await ensureSandbox(win);

step('criterion 6: Fork 19.0-demz-test999 from 19.0');
const prod = await branch(win, pid, '19.0');
let t999 = await branch(win, pid, '19.0-demz-test999');
if (!t999) {
  const r = await bm(win, 'branches.fork', { branchId: prod.id, name: 'test999', push: false });
  t999 = r.branch;
}
console.log('fork:', t999.name, t999.stage, t999.slug);
const b1 = await waitBuild(win, pid, t999);
const mainLog = fs.readFileSync(path.join(process.env.LOCALAPPDATA, 'DEMZ Branch Manager (dev)', 'logs', 'main.log'), 'utf8').split('\n').filter((l) => l.includes('notification')).slice(-2);
console.log('notifications (main.log):', mainLog.join('\n'));

const wt = (await bm(win, 'branches.get', { branchId: t999.id })).worktreePath;
const installed = new Set((await pgq(b1.dbName, "SELECT name FROM ir_module_module WHERE state = 'installed'")).map((r) => r.name));
const modDir = git(wt, 'ls-tree', '-r', '--name-only', 'HEAD')
  .split('\n')
  .filter((f) => f.startsWith('demzua/') && f.endsWith('/__manifest__.py'))
  .map((f) => f.slice(0, -'/__manifest__.py'.length))
  .find((d) => installed.has(d.split('/').pop()));
const mod = modDir.split('/').pop();
console.log('module to change:', modDir);
const pyFile = path.join(wt, modDir, 'bm_ping.py');
fs.writeFileSync(
  pyFile,
  [
    'from odoo import http',
    '',
    '',
    'class BmPing(http.Controller):',
    "    @http.route('/bm/ping', type='http', auth='public')",
    '    def bm_ping(self, **kw):',
    "        marker = 'bm-ping-ok'",
    '        return marker',
    '',
  ].join('\n'),
);
fs.appendFileSync(path.join(wt, modDir, '__init__.py'), '\nfrom . import bm_ping\n');
const verBefore = await pgq(b1.dbName, 'SELECT write_date FROM ir_module_module WHERE name = $1', [mod]);
const otherBefore = await pgq(b1.dbName, "SELECT name, write_date FROM ir_module_module WHERE state = 'installed' AND name <> $1 ORDER BY write_date DESC LIMIT 1", [mod]);
git(wt, 'add', '-A');
git(wt, '-c', 'user.name=bm-check', '-c', 'user.email=bm@example.invalid', 'commit', '-q', '-m', `bm: add /bm/ping to ${mod}`);
console.log('committed in worktree', git(wt, 'rev-parse', '--short', 'HEAD'), '— waiting for the local trigger');
let b2 = b1;
for (let i = 0; i < 40 && b2.id === b1.id; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  b2 = await lastBuild(win, t999.id);
}
b2 = await waitBuild(win, pid, t999);
const verAfter = await pgq(b2.dbName, 'SELECT write_date FROM ir_module_module WHERE name = $1', [mod]);
const otherAfter = await pgq(b2.dbName, 'SELECT write_date FROM ir_module_module WHERE name = $1', [otherBefore[0].name]);
console.log(`update: same DB ${b2.dbName === b1.dbName}; ${mod} write_date ${verBefore[0].write_date.toISOString()} → ${verAfter[0].write_date.toISOString()}; ${otherBefore[0].name} unchanged: ${otherBefore[0].write_date.getTime() === otherAfter[0].write_date.getTime()}`);
const crm = await branch(win, pid, '19.0-demz-crm');
console.log('/bm/ping test999 :', await httpStatus(`${b2.url}/bm/ping`));
console.log('/bm/ping prod     :', await httpStatus(`${prod.url ?? (await branch(win, pid, '19.0')).url}/bm/ping`));
console.log('/bm/ping crm      :', await httpStatus(`${crm.url}/bm/ping`));
console.log('/bm/ping :8019    :', await httpStatus('http://localhost:8019/bm/ping'));

step('criterion 8: debugpy attach with the generated launch.json');
const lj = JSON.parse((await bm(win, 'builds.launchJson', { buildId: b2.id })).json).configurations[0];
console.log('launch.json:', JSON.stringify(lj));
const written = await bm(win, 'builds.writeLaunchJson', { buildId: b2.id });
console.log('written to', written.path, 'gitignore warning:', written.gitignoreWarning);
const dap = new Dap(lj.connect.port);
await dap.connect();
await dap.send('initialize', { adapterID: 'debugpy', clientID: 'bm-check', pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true });
const attach = dap.send('attach', { ...lj, pathMappings: lj.pathMappings });
await dap.waitEvent('initialized', 30000);
const bpLine = 7;
const bp = await dap.send('setBreakpoints', { source: { path: pyFile.replace(/\//g, '\\') }, breakpoints: [{ line: bpLine }] });
console.log('breakpoint:', JSON.stringify(bp.body?.breakpoints));
await dap.send('configurationDone');
await attach;
const req = httpReq(`${b2.url}/bm/ping`).then((r) => r.body.toString());
const stopped = await dap.waitEvent('stopped', 60000).catch((e) => ({ error: e.message }));
if (stopped.body) {
  const st = await dap.send('stackTrace', { threadId: stopped.body.threadId, levels: 1 });
  const top = st.body.stackFrames[0];
  console.log('STOPPED:', stopped.body.reason, '→', top.source?.path, 'line', top.line);
  await dap.send('continue', { threadId: stopped.body.threadId });
} else console.log('not stopped:', stopped.error);
console.log('response after continue:', await req);
await dap.send('disconnect', { terminateDebuggee: false });
dap.close();

step('criterion 6: move to Staging and back via the context menu');
await win.evaluate((id) => (location.hash = `#/projects/bmdev/branches/${id}/history`), t999.id);
await win.waitForTimeout(2000);
for (const target of ['Staging', 'Development']) {
  await win.click(`[data-testid="branch-19.0-demz-test999"]`, { button: 'right' });
  await win.click(`text=→ ${target}`);
  await win.waitForSelector('text=Сменить стадию');
  await shot(win, `c6-move-${target}`);
  await win.click('button:has-text("Сменить стадию")');
  await win.waitForSelector('text=Пересобрать ветку по правилам новой стадии сейчас?');
  await shot(win, `c6-rebuild-offer-${target}`);
  await win.click('button:has-text("Позже")');
  const now = await bm(win, 'branches.get', { branchId: t999.id });
  console.log(`after move → ${now.stage} (${now.assignedBy}); badges: ${now.badges.map((b) => b.kind).join(',')}`);
}
await app.close();
