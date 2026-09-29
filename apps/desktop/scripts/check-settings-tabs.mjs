// Settings: the «Приложение» tab of a project keeps the project route, its tabs and the header's project.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch, bm, shot } from './pw.mjs';
import { ensureSandbox, waitJob } from './sandbox.mjs';

const ID = 'tabs';
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const pause = (ms = 800) => new Promise((r) => setTimeout(r, ms));

const { app, win } = await launch();
try {
  await ensureSandbox(win, { id: ID });
  await win.evaluate((h) => (location.hash = h), `#/projects/${ID}/settings/repo`);
  await pause(1500);
  await win.getByRole('tab', { name: 'Приложение' }).click();
  await pause();
  const hash = await win.evaluate(() => location.hash);
  check('адрес остаётся в проекте', hash === `#/projects/${ID}/settings/app`, hash);
  check('вкладки проекта видны', await win.getByRole('tab', { name: 'Рантайм' }).isVisible());
  check('настройки приложения показаны', await win.getByText('Обновления', { exact: true }).first().isVisible());
  check('Branches в шапке ведёт в проект', (await win.locator('a', { hasText: 'Branches' }).getAttribute('href'))?.includes(`/projects/${ID}/`) ?? false);
  await shot(win, 'settings-app-tab');
  await win.getByRole('tab', { name: 'Postgres' }).click();
  await pause();
  const back = await win.evaluate(() => location.hash);
  check('возврат на вкладку проекта', back === `#/projects/${ID}/settings/postgres`, back);
  await win.evaluate(() => (location.hash = '#/settings/app'));
  await pause();
  check('/settings/app без проекта работает', await win.getByText('Обновления', { exact: true }).first().isVisible());
} finally {
  if ((await bm(win, 'projects.list')).some((p) => p.id === ID)) {
    const j = await waitJob(win, (await bm(win, 'projects.delete', { projectId: ID, confirm: ID })).jobId);
    console.log('песочница удалена:', j.status);
  }
  await app.close();
  // The sandbox profile rewrote the shared bm-traefik with its own networks: the default profile's compose is put back.
  const own = path.join(process.env.LOCALAPPDATA, 'Odoo Branch Manager', 'traefik', 'compose.yml');
  if (fs.existsSync(own)) execFileSync('docker', ['compose', '-p', 'bm-traefik', '-f', own, 'up', '-d'], { stdio: 'ignore' });
}
console.log(`Итого: ${results.filter(Boolean).length} из ${results.length}`);
