// Removes the sandbox project through the app (checks project deletion, spec 8.1) and shows what is left.
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { launch, bm } from './pw.mjs';

const { app, win } = await launch();
const pv = await bm(win, 'projects.deletePreview', { projectId: 'bmdev' });
console.log('preview:', JSON.stringify({ builds: pv.builds.length, databases: pv.databases, worktrees: pv.worktrees }));
await bm(win, 'projects.delete', { projectId: 'bmdev', confirm: 'bmdev' });
for (;;) {
  const j = await bm(win, 'jobs.list', { active: true });
  if (!j.length) break;
  await new Promise((r) => setTimeout(r, 2000));
}
const last = (await bm(win, 'jobs.list', { limit: 1 }))[0];
console.log('job:', last.type, last.status, last.error ?? '');
console.log('projects left:', (await bm(win, 'projects.list')).map((p) => p.id));
await app.close();
const c = new pg.Client({ host: 'localhost', port: 5433, user: 'odoo', password: 'odoo', database: 'postgres' });
await c.connect();
console.log('o19_bmdev_* DBs:', (await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'o19_bmdev_%'")).rows.map((r) => r.datname));
await c.end();
console.log('bm containers:', execFileSync('docker', ['ps', '-a', '--filter', 'label=bm.project=bmdev', '--format', '{{.Names}}'], { encoding: 'utf8' }).trim() || '—');
console.log(execFileSync('git', ['-C', 'E:/bakum_sh/tmp/sandbox/demz-odoo', 'worktree', 'list'], { encoding: 'utf8' }));
