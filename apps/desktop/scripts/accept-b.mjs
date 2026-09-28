// Final acceptance, part B — criterion 2: Production 19.0 ← import of the production .zip on the real DEMZ project.
import fs from 'node:fs';
import pg from 'pg';
import { launch, shot, bm } from './pw.mjs';
import { waitJobs, branch, lastBuild } from './sandbox.mjs';
import { httpReq } from './odoo-http.mjs';

const { app, win } = await launch({ BM_PROFILE: '' });
const pid = 'demz';
const prod = await branch(win, pid, '19.0');
const backups = await bm(win, 'backups.list', { projectId: pid });
console.log('backups:', backups.map((b) => `${b.name} ${Math.round(b.sizeBytes / 1e6)}MB`).join(', '));
const t0 = Date.now();
await bm(win, 'backups.import', { projectId: pid, path: backups[0].path });
await waitJobs(win, pid, 3 * 3600000);
const b = await lastBuild(win, prod.id);
console.log('build', b.number, b.status, b.url, b.dbName, b.errorMessage ?? '', Math.round((Date.now() - t0) / 60000), 'min');
for (const s of b.steps) console.log(' ', s.name, s.status, (s.note ?? '').slice(0, 160));
if (b.status === 'running') {
  const c = new pg.Client({ host: 'localhost', port: 5433, user: 'odoo', password: 'odoo', database: b.dbName });
  await c.connect();
  const ent = await c.query("SELECT key FROM ir_config_parameter WHERE key IN ('database.enterprise_code','database.expiration_date','database.expiration_reason','database.already_linked_subscription_url','database.already_linked_email','database.already_linked_send_mail_url')");
  const url = await c.query("SELECT value FROM ir_config_parameter WHERE key = 'web.base.url'");
  const mail = await c.query('SELECT count(*) FILTER (WHERE active) AS active, count(*) AS total FROM ir_mail_server');
  await c.end();
  console.log('enterprise keys left:', ent.rows.length, '| web.base.url:', url.rows[0]?.value, '| mail servers active/total:', JSON.stringify(mail.rows[0]));
  console.log('filestore dir exists:', fs.existsSync(`E:/demz-odoo-19/data/filestore/${b.dbName}`));
  console.log('HTTP', `${b.url}/web/login`, (await httpReq(`${b.url}/web/login`)).status);
  await win.evaluate((id) => (location.hash = `#/projects/demz/branches/${id}/history`), prod.id);
  await win.waitForTimeout(2500);
  await shot(win, 'B2-prod-mirror');
}
await app.close();
