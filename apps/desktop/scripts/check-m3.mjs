// Milestone 3: an empty build (fresh DB, base only) comes up on *.dev.localhost via Traefik;
// a manual `docker rm` of its container shows up as a discrepancy.
import { execFileSync } from 'node:child_process';
import { launch, shot, bm } from './pw.mjs';
import { ensureSandbox, waitJobs, branch, lastBuild } from './sandbox.mjs';

const { app, win } = await launch();
const pid = await ensureSandbox(win);
await bm(win, 'git.fetch', { projectId: pid });
await waitJobs(win, pid);
const roman = await branch(win, pid, 'demz-roman');
await bm(win, 'branches.setOverrides', { branchId: roman.id, overrides: { database: 'fresh', install: { list: ['base'] }, withDemo: false } });
const t0 = Date.now();
await bm(win, 'builds.rebuild', { branchId: roman.id });
await waitJobs(win, pid, 1800000, async () => {
  const b = await lastBuild(win, roman.id);
  process.stdout.write(`\r${Math.round((Date.now() - t0) / 1000)}s ${b.status} ${b.steps.map((s) => s.name + ':' + s.status[0]).join(' ')}   `);
});
const b = await lastBuild(win, roman.id);
console.log('\nbuild', b.number, b.status, b.url, b.errorMessage ?? '');
for (const s of b.steps) console.log(' ', s.name, s.status, s.note ?? '');
if (b.status === 'running') {
  const out = execFileSync('curl', ['-s', '-o', 'NUL', '-w', '%{http_code} %{redirect_url}', `${b.url}/web/login`], { encoding: 'utf8' });
  console.log('HTTP', b.url, '→', out);
  const sel = execFileSync('curl', ['-s', `${b.url}/web/database/selector`], { encoding: 'utf8' });
  console.log('selector DBs:', [...sel.matchAll(/o19_[a-z0-9_]+/g)].map((m) => m[0]).filter((v, i, a) => a.indexOf(v) === i));
  const cname = execFileSync('docker', ['ps', '--filter', `label=bm.build=${b.id}`, '--format', '{{.Names}}'], { encoding: 'utf8' }).trim();
  console.log('docker rm -f', cname);
  execFileSync('docker', ['rm', '-f', cname]);
  await new Promise((r) => setTimeout(r, 8000));
  const st = await bm(win, 'system.status', { refresh: true });
  console.log('discrepancies:', JSON.stringify(st.discrepancies));
  const br = await bm(win, 'branches.get', { branchId: roman.id });
  console.log('branch badges:', JSON.stringify(br.badges));
  await win.evaluate((id) => (location.hash = `#/projects/bmdev/branches/${id}/history`), roman.id);
  await win.waitForTimeout(2000);
  await shot(win, 'm3-discrepancy');
  await win.evaluate(() => (location.hash = '#/status'));
  await win.waitForTimeout(2000);
  await shot(win, 'm3-status');
}
await app.close();
