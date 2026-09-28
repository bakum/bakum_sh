// While a build runs, the loader icons of the History tab rotate (CSS animation), a queued build shows a clock.
import { launch, shot, bm } from './pw.mjs';
import { ensureSandbox, waitJob, waitJobs, branch } from './sandbox.mjs';

const ID = 'sbx';
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};

const { app, win } = await launch();
try {
  await ensureSandbox(win, {
    id: ID,
    stages: { development: { database: 'fresh', install: { list: ['demz_phone_whatsapp'] }, withDemo: false } },
  });
  await waitJobs(win, ID, 600000);
  const b = await branch(win, ID, 'demz-roman');
  await bm(win, 'builds.rebuild', { branchId: b.id });
  await win.evaluate((h) => (location.hash = h), `#/projects/${ID}/branches/${b.id}/history`);
  const icon = win.locator('svg.tabler-icon-loader-2').first();
  await icon.waitFor({ timeout: 120000 });
  const style = await icon.evaluate((el) => getComputedStyle(el).animationName);
  const t1 = await icon.evaluate((el) => getComputedStyle(el).transform);
  await new Promise((r) => setTimeout(r, 330));
  const t2 = await icon.evaluate((el) => getComputedStyle(el).transform);
  await shot(win, 'spinner');
  check('у иконки есть CSS-анимация', /spin/.test(style), style);
  check('иконка поворачивается', t1 !== t2, `${t1} → ${t2}`);
  await waitJobs(win, ID, 1800000);
} finally {
  if ((await bm(win, 'projects.list')).some((p) => p.id === ID)) {
    const j = await waitJob(win, (await bm(win, 'projects.delete', { projectId: ID, confirm: ID })).jobId);
    console.log('песочница удалена:', j.status);
  }
  await app.close();
}
console.log(`Итого: ${results.filter(Boolean).length} из ${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
