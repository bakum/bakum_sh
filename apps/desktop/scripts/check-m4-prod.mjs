// Milestone 4 / criterion 2 (sandbox): Production = 19.0, import the production .zip → mirror on
// prod.dev.localhost, no enterprise keys, web.base.url = build URL, UI label «Зеркало прода (локально)».
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { launch, shot, bm } from './pw.mjs';
import { ensureSandbox, waitJobs, branch, lastBuild } from './sandbox.mjs';

const { app, win } = await launch();
const pid = await ensureSandbox(win);
await bm(win, 'git.fetch', { projectId: pid });
await waitJobs(win, pid);
const prod = await branch(win, pid, '19.0');
const backups = await bm(win, 'backups.list', { projectId: pid });
console.log('backups:', backups.map((b) => `${b.name} ${Math.round(b.sizeBytes / 1e6)}MB`).join(', '));
const t0 = Date.now();
await bm(win, 'backups.import', { projectId: pid, path: backups[0].path });
let lastLine = '';
await waitJobs(win, pid, 3 * 3600000, async () => {
  const b = await lastBuild(win, prod.id);
  const line = `${Math.round((Date.now() - t0) / 1000)}s ${b.status} ${b.steps.map((s) => s.name + ':' + s.status[0]).join(' ')}`;
  if (line.split(' ').slice(1).join(' ') !== lastLine) console.log(line);
  lastLine = line.split(' ').slice(1).join(' ');
});
const b = await lastBuild(win, prod.id);
console.log('build', b.number, b.status, b.url, b.dbName, b.errorMessage ?? '');
for (const s of b.steps) console.log(' ', s.name, s.status, s.note ?? '');
if (b.status === 'running') {
  const c = new pg.Client({ host: 'localhost', port: 5433, user: 'odoo', password: 'odoo', database: b.dbName });
  await c.connect();
  const ent = await c.query(
    "SELECT key FROM ir_config_parameter WHERE key IN ('database.enterprise_code','database.expiration_date','database.expiration_reason','database.already_linked_subscription_url','database.already_linked_email','database.already_linked_send_mail_url')",
  );
  const url = await c.query("SELECT value FROM ir_config_parameter WHERE key = 'web.base.url'");
  const mail = await c.query('SELECT count(*) FILTER (WHERE active) AS active, count(*) AS total FROM ir_mail_server');
  const att = await c.query("SELECT count(*) AS n FROM ir_attachment WHERE store_fname IS NOT NULL");
  console.log('enterprise keys left:', ent.rows.length, '| web.base.url:', url.rows[0]?.value, '| mail servers active/total:', mail.rows[0], '| stored attachments:', att.rows[0].n);
  await c.end();
  console.log('HTTP /web/login:', execFileSync('curl', ['-s', '-o', 'NUL', '-w', '%{http_code}', `${b.url}/web/login`], { encoding: 'utf8' }));
  await win.evaluate((id) => (location.hash = `#/projects/bmdev/branches/${id}/history`), prod.id);
  await win.waitForTimeout(2500);
  await shot(win, 'm4-prod-mirror');
}
console.log('total', Math.round((Date.now() - t0) / 60000), 'min');
await app.close();
