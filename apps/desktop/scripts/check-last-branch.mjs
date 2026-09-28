// The Branches page reopens the branch (and tab) last open in the project; the first time — the Production branch.
import { launch, shot, bm } from './pw.mjs';
import { ensureSandbox, waitJob, waitJobs, branch } from './sandbox.mjs';

const ID = 'sbx';
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const hash = (win) => win.evaluate(() => location.hash);
const pause = (ms = 2000) => new Promise((r) => setTimeout(r, ms));

const { app, win } = await launch();
try {
  await ensureSandbox(win, { id: ID });
  await waitJobs(win, ID, 600000);
  const prod = await branch(win, ID, '19.0');
  const roman = await branch(win, ID, 'demz-roman');

  await win.evaluate((id) => localStorage.removeItem(`bm.lastBranch.${id}`), ID);
  await win.evaluate((h) => (location.hash = h), `#/projects/${ID}/branches`);
  await pause();
  check('в первый раз открывается Production', (await hash(win)) === `#/projects/${ID}/branches/${prod.id}`, await hash(win));

  await win.evaluate((h) => (location.hash = h), `#/projects/${ID}/branches/${roman.id}/editor`);
  await pause();
  await win.getByRole('link', { name: 'Settings' }).click();
  await pause();
  check('открыты настройки', (await hash(win)).includes('/settings'), await hash(win));
  await win.getByRole('link', { name: 'Branches' }).click();
  await pause();
  check('после Settings открыта та же ветка и вкладка', (await hash(win)) === `#/projects/${ID}/branches/${roman.id}/editor`, await hash(win));
  await shot(win, 'last-branch');

  await win.getByRole('link', { name: 'Builds' }).click();
  await pause();
  await win.getByRole('link', { name: 'Branches' }).click();
  await pause();
  check('после Builds тоже', (await hash(win)) === `#/projects/${ID}/branches/${roman.id}/editor`, await hash(win));
} finally {
  if ((await bm(win, 'projects.list')).some((p) => p.id === ID)) {
    const j = await waitJob(win, (await bm(win, 'projects.delete', { projectId: ID, confirm: ID })).jobId);
    console.log('песочница удалена:', j.status);
  }
  await app.close();
}
console.log(`Итого: ${results.filter(Boolean).length} из ${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
