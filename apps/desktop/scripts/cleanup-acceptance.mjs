// Removes the acceptance test resources on the real profile through the app:
// branch 19.0-demz-test999 (Delete), project `second` (Delete project), failed build 19.0-demz-crm #1 (Drop).
import { launch, bm } from './pw.mjs';
import { branch } from './sandbox.mjs';

const { app, win } = await launch({ BM_PROFILE: '' });
const waitAll = async () => {
  while ((await bm(win, 'jobs.list', { active: true })).length) await new Promise((r) => setTimeout(r, 2000));
};
const t = await branch(win, 'demz', '19.0-demz-test999');
if (t) {
  const pv = await bm(win, 'branches.deletePreview', { branchId: t.id });
  console.log('test999 preview:', JSON.stringify(pv));
  await bm(win, 'branches.delete', { branchId: t.id, confirmSlug: t.slug, deleteLocal: false, deleteRemote: false, forceDirty: false });
  await waitAll();
}
if ((await bm(win, 'projects.list')).some((p) => p.id === 'second')) {
  await bm(win, 'projects.delete', { projectId: 'second', confirm: 'second' });
  await waitAll();
}
const crm = await branch(win, 'demz', '19.0-demz-crm');
for (const b of (await bm(win, 'builds.list', { branchId: crm.id, limit: 50 })).items.filter((x) => x.status === 'failed')) {
  await bm(win, 'builds.drop', { buildId: b.id });
  await waitAll();
  console.log(`crm #${b.number}:`, (await bm(win, 'builds.get', { buildId: b.id })).status);
}
for (const j of await bm(win, 'jobs.list', { limit: 4 })) console.log(`${j.type}: ${j.status}${j.error ? ' — ' + j.error : ''}`);
console.log('projects:', (await bm(win, 'projects.list')).map((p) => p.id).join(', '));
const st = await bm(win, 'system.status', { refresh: true });
console.log('discrepancies:', st.discrepancies.length, '| orphans:', JSON.stringify(st.orphans));
await app.close();
