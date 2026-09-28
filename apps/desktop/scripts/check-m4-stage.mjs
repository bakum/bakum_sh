// Criteria 4, 5, 12 in the sandbox:
//  4 — staging 19.0-demz-crm from a copy of the prod mirror: URL works with prod data, product images present,
//      the DB selector lists only this build's DB;
//  5 — a new commit in origin/19.0-demz-crm → after fetch a new History entry, the changed module updated, same DB;
// 12 — the branch open in the main checkout with tracking: local → clear error, nothing created.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { launch, shot, bm } from './pw.mjs';
import { ensureSandbox, waitJobs, branch, lastBuild, SANDBOX } from './sandbox.mjs';
import { odooGet, odooLogin } from './odoo-http.mjs';

const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const step = (s) => console.log(`\n=== ${s}`);

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

step('criterion 4: staging crm = copy of the prod mirror');
let crm = await branch(win, pid, '19.0-demz-crm');
await bm(win, 'git.fetch', { projectId: pid });
await waitJobs(win, pid);
for (const f of (await bm(win, 'builds.list', { branchId: crm.id, limit: 50 })).items.filter((x) => x.status === 'failed')) {
  await bm(win, 'builds.drop', { buildId: f.id });
  await waitJobs(win, pid);
  const d = await bm(win, 'builds.get', { buildId: f.id });
  console.log(`dropped failed #${d.number}: ${d.status}, DB ${d.dbName}`);
}
crm = await branch(win, pid, '19.0-demz-crm');
if (!crm.liveBuild || crm.liveBuild.status !== 'running') await bm(win, 'builds.rebuild', { branchId: crm.id });
else console.log('reusing live build', crm.liveBuild.number);
const b4 = await waitBuild(win, pid, crm);
const pgc = async (db) => {
  const c = new pg.Client({ host: 'localhost', port: 5433, user: 'odoo', password: 'odoo', database: db });
  await c.connect();
  return c;
};
if (b4.status === 'running') {
  const c = await pgc(b4.dbName);
  const img = await c.query(
    "SELECT res_id, store_fname FROM ir_attachment WHERE res_model = 'product.template' AND res_field = 'image_1920' AND store_fname IS NOT NULL LIMIT 1",
  );
  const partners = await c.query('SELECT count(*) AS n FROM res_partner');
  const url = await c.query("SELECT value FROM ir_config_parameter WHERE key = 'web.base.url'");
  await c.end();
  console.log('partners (prod data):', partners.rows[0].n, '| web.base.url:', url.rows[0]?.value);
  const fsFile = img.rows[0] ? `${SANDBOX}/filestore/${b4.dbName}/${img.rows[0].store_fname}` : null;
  console.log('product image file in build filestore:', fsFile, fsFile && fs.existsSync(fsFile));
  const cred = await bm(win, 'builds.credentials', { buildId: b4.id });
  const s = await odooLogin(b4.url, cred.login, cred.password);
  console.log('login', cred.login, '→', s.status);
  if (img.rows[0]) {
    const r = await odooGet(b4.url, `/web/image/product.template/${img.rows[0].res_id}/image_128`, s.session);
    console.log('GET product image →', r.status, r.type, r.body.length, 'bytes');
  }
  const sel = await odooGet(b4.url, '/web/database/selector');
  console.log('selector DBs:', [...new Set([...sel.body.toString().matchAll(/o19_[a-z0-9_]+/g)].map((m) => m[0]))]);
  await win.evaluate((id) => (location.hash = `#/projects/bmdev/branches/${id}/history`), crm.id);
  await win.waitForTimeout(2000);
  await shot(win, 'c4-crm');
}

step('criterion 5: new commit in origin/19.0-demz-crm');
const pusher = `${SANDBOX}/pusher`;
if (!fs.existsSync(pusher)) execFileSync('git', ['clone', '-q', `${SANDBOX}/origin.git`, pusher]);
git(pusher, 'fetch', '-q', 'origin');
git(pusher, 'checkout', '-q', '-B', '19.0-demz-crm', 'origin/19.0-demz-crm');
const c5 = await pgc(b4.dbName);
const inst = (await c5.query("SELECT name FROM ir_module_module WHERE state = 'installed' AND name LIKE 'demz_%' ORDER BY name")).rows.map((r) => r.name);
const tree = git(pusher, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n');
const modDir = tree.filter((f) => f.endsWith('/__manifest__.py')).map((f) => f.slice(0, -'/__manifest__.py'.length)).find((d) => inst.includes(d.split('/').pop()));
const modName = modDir.split('/').pop();
const before = (await c5.query('SELECT latest_version, write_date FROM ir_module_module WHERE name = $1', [modName])).rows[0];
const partnersBefore = (await c5.query("SELECT count(*) AS n FROM res_partner")).rows[0].n;
await c5.query("INSERT INTO ir_config_parameter (key, value) VALUES ('bm.marker', 'kept') ON CONFLICT (key) DO UPDATE SET value = 'kept'");
await c5.end();
fs.appendFileSync(`${pusher}/${modDir}/__init__.py`, `\n# bm check ${new Date().toISOString()}\n`);
git(pusher, 'add', '-A');
git(pusher, '-c', 'user.name=bm-check', '-c', 'user.email=bm@example.invalid', 'commit', '-q', '-m', `bm: touch ${modName}`);
git(pusher, 'push', '-q', 'origin', '19.0-demz-crm');
const sha = git(pusher, 'rev-parse', 'HEAD');
console.log('pushed', sha.slice(0, 7), 'touching', modName, '(module write_date before:', before?.write_date?.toISOString?.() ?? before, ')');
await bm(win, 'git.fetch', { projectId: pid });
await new Promise((r) => setTimeout(r, 4000));
const b5 = await waitBuild(win, pid, crm);
console.log('commit of the new build:', b5.commitSha?.slice(0, 7), b5.commits.map((c) => c.message).join(' | '));
const c5b = await pgc(b5.dbName);
const after = (await c5b.query('SELECT write_date FROM ir_module_module WHERE name = $1', [modName])).rows[0];
const marker = (await c5b.query("SELECT value FROM ir_config_parameter WHERE key = 'bm.marker'")).rows[0];
const partnersAfter = (await c5b.query("SELECT count(*) AS n FROM res_partner")).rows[0].n;
await c5b.end();
console.log(`module ${modName} write_date after:`, after?.write_date?.toISOString?.(), '| same DB:', b5.dbName === b4.dbName, '| marker kept:', marker?.value, '| partners', partnersBefore, '→', partnersAfter);
const hist = await bm(win, 'builds.list', { branchId: crm.id, limit: 5 });
console.log('history:', hist.items.map((x) => `#${x.number} ${x.kind} ${x.status} ${x.commitSha?.slice(0, 7)}`).join(', '));
await win.evaluate((id) => (location.hash = `#/projects/bmdev/branches/${id}/history`), crm.id);
await win.waitForTimeout(2000);
await shot(win, 'c5-crm-update');

step('criterion 12: branch in the main checkout, tracking: local');
const perev = await branch(win, pid, '19.0-demz-perevertum');
const dbsBefore = (await (async () => { const c = await pgc('postgres'); const r = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'o19_bmdev_%'"); await c.end(); return r.rows.map((x) => x.datname); })());
try {
  await bm(win, 'builds.rebuild', { branchId: perev.id });
  console.log('UNEXPECTED: build queued');
} catch (e) {
  console.log('error:', String(e.message).replace(/^.*Error: /, ''));
}
const perevAfter = await bm(win, 'branches.get', { branchId: perev.id });
const hist12 = await bm(win, 'builds.list', { branchId: perev.id });
const dbsAfter = (await (async () => { const c = await pgc('postgres'); const r = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'o19_bmdev_%'"); await c.end(); return r.rows.map((x) => x.datname); })());
console.log('builds:', hist12.total, '| worktree:', perevAfter.worktreePath, '| new DBs:', dbsAfter.filter((d) => !dbsBefore.includes(d)));
console.log('git worktree list:\n' + git(`${SANDBOX}/demz-odoo`, 'worktree', 'list'));
await app.close();
