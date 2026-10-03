// D75: an outdated assistant skill is a warning under the header on every page and a desktop notification, never a
// silent rewrite. «Обновить» on the warning writes the skill; a skill edited by hand only gets «Открыть» (settings).
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { launch, bm, shot } from './pw.mjs';
import { SANDBOX, ensureSandbox, waitJob, waitJobs } from './sandbox.mjs';

const ID = 'bmskb';
const DIR = `${SANDBOX}/skill-banner`;
const MAIN_LOG = path.join(process.env.LOCALAPPDATA, 'Odoo Branch Manager (dev)', 'logs', 'main.log');
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
/** Notifications main logged since `since` (ms); main.log is buffered and complete only after the app closes. */
const notificationsSince = (since) =>
  (fs.existsSync(MAIN_LOG) ? fs.readFileSync(MAIN_LOG, 'utf8').split('\n') : [])
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((j) => j?.msg === 'notification' && j.time >= since);
let touchedAt = 0;

const { app, win } = await launch();
win.setDefaultTimeout(30000);
const original = (await bm(win, 'config.get', { level: 'app' })).yaml;
const banner = () => win.locator('[data-testid="skill-banner"]');
const touchSettings = async (n) => {
  const doc = YAML.parseDocument((await bm(win, 'projects.get', { projectId: ID })).yaml);
  doc.setIn(['repo', 'fetchIntervalMin'], n);
  await bm(win, 'projects.update', { projectId: ID, yaml: doc.toString() });
};
try {
  const lang = YAML.parseDocument(original);
  lang.set('language', 'ru');
  await bm(win, 'config.put', { level: 'app', yaml: lang.toString() });
  await ensureSandbox(win, { id: ID, stages: { production: { buildOnAdd: false }, development: { buildOnAdd: false } } });
  await waitJobs(win, ID, 600000);
  fs.mkdirSync(DIR, { recursive: true });
  const { path: file } = await bm(win, 'agents.installSkill', { projectId: ID, dir: DIR, overwrite: false });
  await win.evaluate(() => (location.hash = '#/status'));
  await pause(2500);
  check('свежий skill — плашки нет', (await banner().count()) === 0);

  // 1. Settings change → warning on any page and a desktop notification; «Обновить» right on it.
  touchedAt = Date.now();
  await touchSettings(7);
  await win.evaluate((id) => (location.hash = `#/projects/${id}/branches`), ID);
  await banner().first().waitFor({ timeout: 30000 });
  check('плашка «устарел» на странице веток', (await banner().first().innerText()).includes('устарел'));
  await shot(win, 'skill-banner');
  await pause(8000);
  const before = fs.readFileSync(file, 'utf8');
  check('файл сам не переписан', (await bm(win, 'agents.skillStatus', { projectId: ID })).state === 'outdated' && fs.readFileSync(file, 'utf8') === before);
  await banner().first().getByRole('button', { name: 'Обновить' }).click();
  await pause(3000);
  check('«Обновить» на плашке — skill актуален', (await bm(win, 'agents.skillStatus', { projectId: ID })).state === 'current');
  check('плашка исчезла', (await banner().count()) === 0);

  // 2. Hand edit + settings change → «Открыть» to the project settings, no one-click overwrite.
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('## ', '## (моя правка) '));
  await touchSettings(9);
  await banner().first().waitFor({ timeout: 30000 });
  check('правленый вручную: кнопка «Открыть»', (await banner().first().getByRole('button', { name: 'Открыть' }).count()) === 1 && (await banner().first().getByRole('button', { name: 'Обновить' }).count()) === 0);
  await banner().first().getByRole('button', { name: 'Открыть' }).click();
  await pause(1500);
  check('«Открыть» ведёт в «Ассистенты»', (await win.evaluate(() => location.hash)).endsWith(`/projects/${ID}/settings/agents`));

  // 3. «Позже» hides the warning for this run.
  await banner().first().getByRole('button', { name: 'Позже' }).click();
  await pause(1000);
  check('«Позже» скрывает плашку', (await banner().count()) === 0);
} finally {
  try {
    if ((await bm(win, 'projects.list')).some((p) => p.id === ID)) {
      const j = await waitJob(win, (await bm(win, 'projects.delete', { projectId: ID, confirm: ID })).jobId);
      console.log(`проект ${ID} удалён: ${j.status}`);
    }
    await bm(win, 'config.put', { level: 'app', yaml: original });
  } finally {
    await app.close();
    fs.rmSync(DIR, { recursive: true, force: true });
  }
}
await pause(1000);
const sent = notificationsSince(touchedAt).filter((n) => n.type === 'skillOutdated');
check('уведомление Windows о skill', sent.length >= 1 && sent[0].title.includes('Sandbox'), sent.map((n) => n.title).join(' | '));
console.log(`Итого: ${results.filter(Boolean).length} из ${results.length}`);
