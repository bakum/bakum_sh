// Status page orphans: ticking and unticking an orphan keeps the page (the checkbox handler used to read
// e.currentTarget inside the setState updater and the whole window went blank). The orphan is a created, never
// started container labelled with an unknown bm.project — no project, sandbox or database is involved.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launch, shot } from './pw.mjs';

const NAME = 'bm-bmorphan-check-1';
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

try {
  docker('rm', '-f', NAME);
} catch {
  /* not there */
}
docker('create', '--name', NAME, '--label', 'bm.project=bmorphan', 'node:22-alpine', 'true');

const { app, win } = await launch();
try {
  await win.evaluate(() => (location.hash = '#/status'));
  const row = win.locator('tr', { hasText: NAME });
  await row.waitFor({ timeout: 60000 });
  check('сирота видна на Status', true);
  const box = row.locator('input[type=checkbox]');
  const del = win.getByRole('button', { name: 'Удалить выбранные' });

  await box.click();
  check('галочка ставится', await box.isChecked());
  check('«Удалить выбранные» доступна', await del.isEnabled());

  await box.click();
  await win.waitForTimeout(1500);
  check('перехватчик ошибок не сработал', (await win.getByTestId('error-boundary').count()) === 0);
  check('строка сироты на месте', await row.isVisible());
  check('галочка снята', !(await box.isChecked()));
  check('«Удалить выбранные» снова недоступна', await del.isDisabled());

  // Several rounds: the crash showed up on later updates, not on the first one.
  for (let i = 0; i < 3; i++) {
    await box.click();
    await box.click();
  }
  await win.waitForTimeout(1000);
  check('после нескольких кругов страница цела', (await row.isVisible()) && !(await box.isChecked()));
  await shot(win, 'status-orphans');
} catch (err) {
  check('без исключений', false, err.stack ?? err.message);
  await shot(win, 'status-orphans-fail').catch(() => {});
} finally {
  await app.close();
  try {
    docker('rm', '-f', NAME);
  } catch {
    /* already gone */
  }
  const own = path.join(process.env.LOCALAPPDATA, 'Odoo Branch Manager', 'traefik', 'compose.yml');
  if (fs.existsSync(own)) docker('compose', '-p', 'bm-traefik', '-f', own, 'up', '-d');
}
console.log(`Итого: ${results.filter(Boolean).length} из ${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
