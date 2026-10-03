// Interface languages (D69): app.yaml `language` switches the window, Core messages and the bm command; the first-run
// wizard offers the choice. Screenshots of the main pages in uk / en / ru; the dev profile's app.yaml is restored.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { launch, bm, shot, electronExe } from './pw.mjs';
import { ensureSandbox, waitJob, waitJobs } from './sandbox.mjs';

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).trim();
const BIN = path.join(process.env.LOCALAPPDATA, 'Odoo Branch Manager (dev)', 'bin');
const env = () => {
  const e = { ...process.env };
  delete e.ELECTRON_RUN_AS_NODE;
  return e;
};
const bmCmd = (...args) => spawnSync('cmd.exe', ['/d', '/c', path.join(BIN, 'bm.cmd'), ...args], { encoding: 'utf8', env: env(), timeout: 60000 });

const ID = 'bmi18n';
/** The bm client itself (cli.js, plain Node) with a pipe nobody listens on: its own message, exit code 2. */
const bmClientOffline = () =>
  spawnSync(electronExe, [path.join(BIN, 'cli.js'), 'help'], {
    encoding: 'utf8',
    env: { ...env(), ELECTRON_RUN_AS_NODE: '1', BM_PIPE: '\\.\pipe\bm-i18n-nobody' },
    timeout: 30000,
  });

const { app, win } = await launch();
const original = await bm(win, 'config.get', { level: 'app' });
const setLanguage = async (lang) => {
  const doc = YAML.parseDocument((await bm(win, 'config.get', { level: 'app' })).yaml);
  doc.set('language', lang);
  await bm(win, 'config.put', { level: 'app', yaml: doc.toString() });
  await win.waitForTimeout(2500);
};
const text = (sel) => win.locator(sel).first().innerText();
try {
  await win.evaluate(() => localStorage.setItem('bm-color-scheme', 'light'));
  await win.reload();
  await win.setViewportSize({ width: 1600, height: 950 });
  await win.waitForTimeout(3000);
  // Builds are not needed for the pages: nothing is built on add.
  await ensureSandbox(win, { id: ID, stages: { production: { buildOnAdd: false }, development: { buildOnAdd: false } } });
  await waitJobs(win, ID, 600000);
  const p = (await bm(win, 'projects.list')).find((x) => x.id === ID);

  const expected = {
    uk: { footer: 'Перевірити оновлення', error: 'Проєкт «nope» не знайдено', cli: 'командний рядок', off: 'не запущено', html: 'uk' },
    en: { footer: 'Check for updates', error: 'Project «nope» not found', cli: 'command line', off: 'is not running', html: 'en' },
    ru: { footer: 'Проверить обновления', error: 'Проект «nope» не найден', cli: 'командная строка', off: 'не запущен', html: 'ru' },
  };
  for (const lang of ['uk', 'en', 'ru']) {
    await setLanguage(lang);
    const e = expected[lang];
    check(`${lang}: <html lang>`, (await win.evaluate(() => document.documentElement.lang)) === e.html);
    const footer = await text('[data-testid="footer-update"]').catch(() => '');
    check(`${lang}: footer`, footer.includes(e.footer), footer);
    const err = await win.evaluate(() => window.bm.settle('projects.get', { projectId: 'nope' }));
    check(`${lang}: Core error`, !err.ok && err.error.message === e.error, err.error?.message);
    const help = bmCmd('help');
    check(`${lang}: bm help`, help.stdout.includes(e.cli), help.stdout.split('\n')[0]);
    const off = bmClientOffline();
    check(`${lang}: bm client message (app not reachable)`, off.status === 2 && off.stderr.includes(e.off), off.stderr.trim());

    if (p) {
      await win.evaluate((h) => (location.hash = h), `#/projects/${p.id}/branches`);
      await win.waitForTimeout(2000);
      const first = win.locator('[data-testid^="branch-"]').first();
      if (await first.count()) {
        await first.click({ force: true });
        await win.waitForTimeout(2500);
      }
      await shot(win, `i18n-${lang}-branch`);
      await win.evaluate((h) => (location.hash = h), `#/projects/${p.id}/settings/stages`);
      await win.waitForTimeout(2000);
      await shot(win, `i18n-${lang}-settings`);
    }
    await win.evaluate(() => (location.hash = '#/settings/app'));
    await win.waitForTimeout(2000);
    await shot(win, `i18n-${lang}-app-settings`);
    await win.evaluate(() => (location.hash = '#/status'));
    await win.waitForTimeout(2500);
    await shot(win, `i18n-${lang}-status`);
  }

  // The wizard's own switch changes the window only (app.yaml keeps ru here).
  await win.evaluate(() => (location.hash = '#/welcome'));
  await win.waitForTimeout(2000);
  await win.locator('[data-testid="welcome-language"]').getByText('English').click();
  await win.waitForTimeout(1500);
  const next = await win.getByRole('button', { name: 'Next: add a project' }).count();
  check('welcome: language switch', next === 1);
  await shot(win, 'i18n-welcome-en');
  const cfg = await bm(win, 'config.app');
  check('welcome: app.yaml untouched', cfg.language === 'ru', cfg.language);
} finally {
  await bm(win, 'config.put', { level: 'app', yaml: original.yaml }).catch((e) => console.log('restore failed', e));
  if ((await bm(win, 'projects.list')).some((x) => x.id === ID)) {
    const j = await waitJob(win, (await bm(win, 'projects.delete', { projectId: ID, confirm: ID })).jobId);
    console.log('sandbox deleted:', j.status);
  }
  await app.close();
  const own = path.join(process.env.LOCALAPPDATA, 'Odoo Branch Manager', 'traefik', 'compose.yml');
  if (fs.existsSync(own)) docker('compose', '-p', 'bm-traefik', '-f', own, 'up', '-d');
}
const failed = results.filter((x) => !x).length;
console.log(failed ? `${failed} FAILED` : 'ALL OK');
process.exit(failed ? 1 : 0);
