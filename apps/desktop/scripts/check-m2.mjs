// Milestone 2: fetch → layout like odoo.sh; sandbox worktrees (remote / local) are created and removed;
// a branch open in the main checkout gives a clear error.
import { execFileSync } from 'node:child_process';
import { launch, shot, bm } from './pw.mjs';
import { ensureSandbox, waitJobs } from './sandbox.mjs';

const repo = 'E:/demz-odoo-19/repositories/demz-odoo';
const wt = () => execFileSync('git', ['-C', repo, 'worktree', 'list'], { encoding: 'utf8' }).trim();
const { app, win } = await launch();
const pid = await ensureSandbox(win);
await bm(win, 'git.fetch', { projectId: pid });
await waitJobs(win, pid);
const l = await bm(win, 'branches.list', { projectId: pid });
console.log('production :', l.production.map((b) => `${b.name}(${b.slug})`).join(', '));
console.log('development:', l.development.map((b) => `${b.name}(${b.slug})`).join(', '));
console.log('unassigned :', l.unassigned.map((u) => u.name).join(', '), '| ignored:', l.ignoredCount);

const byName = (n) => [...l.production, ...l.development].find((b) => b.name === n);
const crm = byName('19.0-demz-crm');
const roman = byName('demz-roman');
const perev = byName('19.0-demz-perevertum');

console.log('worktree crm (remote):', (await bm(win, 'branches.ensureWorktree', { branchId: crm.id })).path);
console.log('worktree roman (local):', (await bm(win, 'branches.ensureWorktree', { branchId: roman.id })).path);
try {
  await bm(win, 'branches.ensureWorktree', { branchId: perev.id });
  console.log('perevertum: UNEXPECTED success');
} catch (e) {
  console.log('perevertum error:', String(e.message).slice(0, 160));
}
console.log(wt());

await win.evaluate(() => (location.hash = '#/projects/bmdev/branches'));
await win.waitForTimeout(1500);
await win.click(`[data-testid="branch-19.0-demz-crm"]`);
await win.waitForTimeout(1500);
await shot(win, 'm2-branches');

// Remove: demz-roman and crm (protection off first, if its rule sets it)
await bm(win, 'branches.delete', { branchId: roman.id, confirmSlug: roman.slug, deleteLocal: false, deleteRemote: false, forceDirty: false });
await bm(win, 'branches.setOverrides', { branchId: crm.id, overrides: { protected: false } });
await bm(win, 'branches.delete', { branchId: crm.id, confirmSlug: crm.slug, deleteLocal: false, deleteRemote: false, forceDirty: false });
await waitJobs(win, pid);
console.log('after delete:\n' + wt());
const jobs = await bm(win, 'jobs.list', { projectId: pid, limit: 5 });
console.log(jobs.map((j) => `${j.type}:${j.status}${j.error ? ' ' + j.error : ''}`).join('\n'));
// Bring the two branches back for later milestones
await bm(win, 'branches.add', { projectId: pid, name: '19.0-demz-crm' });
await bm(win, 'branches.add', { projectId: pid, name: 'demz-roman' });
await app.close();
