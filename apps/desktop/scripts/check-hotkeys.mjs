// D71: hotkeys of spec 7 on the sandbox project (no builds): Ctrl+K from another page opens Branches with the filter
// focused, Enter opens the first match, Escape clears; Ctrl+R starts a fetch; F5 refetches without reloading the window.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { launch, bm, shot } from './pw.mjs';
import { ensureSandbox, waitJob, waitJobs } from './sandbox.mjs';

const ID = 'bmkeys';
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};

const { app, win } = await launch();
win.setDefaultTimeout(30000);
const original = (await bm(win, 'config.get', { level: 'app' })).yaml;
try {
  const doc = YAML.parseDocument(original);
  doc.set('language', 'ru');
  await bm(win, 'config.put', { level: 'app', yaml: doc.toString() });
  await ensureSandbox(win, { id: ID, stages: { production: { buildOnAdd: false }, development: { buildOnAdd: false } } });
  await waitJobs(win, ID, 600000);
  const branches = await bm(win, 'branches.list', { projectId: ID });
  const target = branches.development.find((b) => b.name.includes('roman')) ?? branches.development[0];
  check('в песочнице есть ветка Development', !!target, target?.name ?? 'нет');

  await win.evaluate((id) => (location.hash = `#/projects/${id}/settings/repo`), ID);
  await win.waitForTimeout(1500);
  await win.evaluate(() => (window.__bmMarker = 1));
  await win.keyboard.press('Control+K');
  await win.waitForTimeout(1500);
  check('Ctrl+K: открыта страница веток', (await win.evaluate(() => location.hash)).includes('/branches'));
  check('Ctrl+K: фокус в фильтре', await win.evaluate(() => document.activeElement?.id === 'bm-branch-filter'));
  const placeholder = await win.locator('#bm-branch-filter').getAttribute('placeholder');
  check('подсказка фильтра называет клавиши', placeholder?.includes('Ctrl+K'), placeholder ?? '');

  await win.keyboard.type(target.name.slice(-6));
  await win.keyboard.press('Enter');
  await win.waitForTimeout(1500);
  check('Enter: открыта найденная ветка', (await win.evaluate(() => location.hash)).includes(`/branches/${target.id}`));
  await win.locator('#bm-branch-filter').focus();
  await win.keyboard.press('Escape');
  check('Escape: фильтр очищен', (await win.locator('#bm-branch-filter').inputValue()) === '');

  const before = (await bm(win, 'jobs.list', { projectId: ID, limit: 50 })).filter((j) => j.type === 'fetch').length;
  await win.keyboard.press('Control+R');
  await win.waitForTimeout(2500);
  const fetches = (await bm(win, 'jobs.list', { projectId: ID, limit: 50 })).filter((j) => j.type === 'fetch');
  check('Ctrl+R: fetch запущен', fetches.length === before + 1, `${before} → ${fetches.length}`);
  if (fetches[0]) await waitJob(win, fetches[0].id);
  check('Ctrl+R: окно не перезагружено', (await win.evaluate(() => window.__bmMarker)) === 1);

  await win.keyboard.press('F5');
  await win.waitForTimeout(1500);
  check('F5: окно не перезагружено', (await win.evaluate(() => window.__bmMarker)) === 1);
  await shot(win, 'hotkeys');
} finally {
  try {
    if ((await bm(win, 'projects.list')).some((p) => p.id === ID)) {
      const j = await waitJob(win, (await bm(win, 'projects.delete', { projectId: ID, confirm: ID })).jobId);
      console.log(`проект ${ID} удалён: ${j.status}`);
    }
    await bm(win, 'config.put', { level: 'app', yaml: original });
  } finally {
    await app.close();
    const own = path.join(process.env.LOCALAPPDATA, 'Odoo Branch Manager', 'traefik', 'compose.yml');
    if (fs.existsSync(own)) execFileSync('docker', ['compose', '-p', 'bm-traefik', '-f', own, 'up', '-d']);
  }
}
console.log(`Итого: ${results.filter(Boolean).length} из ${results.length}`);
