// Criterion 11 in the sandbox: kill the whole app during a build → after restart the job is `interrupted`, the build
// `failed`, the previous live build keeps working; «Отбросить» removes the DB, filestore and containers of the failed build.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { launch, shot, bm } from './pw.mjs';
import { httpReq } from './odoo-http.mjs';
import { ensureSandbox, waitJobs, branch, lastBuild, SANDBOX } from './sandbox.mjs';

const dbs = async () => {
  const c = new pg.Client({ host: 'localhost', port: 5433, user: 'odoo', password: 'odoo', database: 'postgres' });
  await c.connect();
  const r = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'o19_bmdev_%' ORDER BY 1");
  await c.end();
  return r.rows.map((x) => x.datname);
};
const containers = (id) => execFileSync('docker', ['ps', '-a', '--filter', `label=bm.build=${id}`, '--format', '{{.Names}} {{.Status}}'], { encoding: 'utf8' }).trim();

let { app, win } = await launch();
const pid = await ensureSandbox(win);
const crm = await branch(win, pid, '19.0-demz-crm');
const live = crm.liveBuild;
console.log('live before:', `#${live.number}`, live.status, live.url);
await bm(win, 'builds.rebuild', { branchId: crm.id });
let b;
for (;;) {
  b = await lastBuild(win, crm.id);
  const running = b.steps.find((s) => s.status === 'running');
  if (running && ['filestore', 'modules', 'local-tweaks'].includes(running.name)) break;
  if (b.status === 'failed' || b.status === 'running') break;
  await new Promise((r) => setTimeout(r, 500));
}
const running = b.steps.find((s) => s.status === 'running')?.name;
console.log(`killing the app during build #${b.number}, step ${running}`);
const mainPid = app.process().pid;
execFileSync('taskkill', ['/F', '/T', '/PID', String(mainPid)]);
await new Promise((r) => setTimeout(r, 3000));

({ app, win } = await launch());
await new Promise((r) => setTimeout(r, 6000));
const jobs = await bm(win, 'jobs.list', { projectId: pid, limit: 3 });
console.log('jobs after restart:', jobs.map((j) => `${j.type}#${j.id}:${j.status}`).join(', '));
const failed = await bm(win, 'builds.get', { buildId: b.id });
console.log(`build #${failed.number}: ${failed.status} — ${failed.errorMessage}`);
const liveNow = (await bm(win, 'branches.get', { branchId: crm.id })).liveBuild;
const http = await httpReq(`${liveNow.url}/web/login`).then((r) => r.status).catch((e) => e.message);
console.log(`previous live: #${liveNow.number} ${liveNow.status} ${liveNow.containerState} HTTP ${http}`);
console.log('resources of the failed build: DB', (await dbs()).includes(failed.dbName), '| filestore', fs.existsSync(`${SANDBOX}/filestore/${failed.dbName}`), '| containers:', containers(failed.id) || '—');
await win.evaluate((id) => (location.hash = `#/projects/bmdev/branches/${id}/history`), crm.id);
await win.waitForTimeout(2500);
await shot(win, 'c11-interrupted');

await bm(win, 'builds.drop', { buildId: failed.id });
await waitJobs(win, pid);
const dropped = await bm(win, 'builds.get', { buildId: failed.id });
console.log(`after «Отбросить»: build ${dropped.status}; DB ${(await dbs()).includes(failed.dbName)}; filestore ${fs.existsSync(`${SANDBOX}/filestore/${failed.dbName}`)}; containers: ${containers(failed.id) || '—'}`);
const liveAfter = (await bm(win, 'branches.get', { branchId: crm.id })).liveBuild;
console.log(`live still: #${liveAfter.number} ${liveAfter.status}`);
await app.close();
