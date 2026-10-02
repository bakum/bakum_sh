// Screenshots of the light scheme (gray page, off-white surfaces): branch history, logs, settings.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launch, bm, shot } from './pw.mjs';

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).trim();
const { app, win } = await launch();
try {
  await win.evaluate(() => localStorage.setItem('bm-color-scheme', 'light'));
  await win.reload();
  await win.setViewportSize({ width: 1600, height: 950 });
  await win.waitForTimeout(3000);
  const projects = await bm(win, 'projects.list');
  console.log('projects', projects.map((p) => p.id));
  const p = projects[0];
  if (p) {
    await win.evaluate((h) => (location.hash = h), `#/projects/${p.id}/branches`);
    await win.waitForTimeout(2000);
    await shot(win, 'light-gray-branches');
    const first = win.locator('[data-testid^="branch-"]').first();
    if (await first.count()) {
      await first.click();
      await win.waitForTimeout(2500);
      await shot(win, 'light-gray-history');
      await win.evaluate(() => (location.hash = location.hash.replace(/\/[a-z]+$/, '/logs')));
      await win.waitForTimeout(2500);
      await shot(win, 'light-gray-logs');
    }
    await win.evaluate((h) => (location.hash = h), `#/projects/${p.id}/settings`);
    await win.waitForTimeout(2500);
    await shot(win, 'light-gray-settings');
  }
  await win.evaluate(() => (location.hash = '#/settings/app'));
  await win.waitForTimeout(2500);
  await shot(win, 'light-gray-app-settings');
  await win.evaluate(() => (location.hash = '#/status'));
  await win.waitForTimeout(2500);
  await shot(win, 'light-gray-status');
} finally {
  await app.close();
  const own = path.join(process.env.LOCALAPPDATA, 'Odoo Branch Manager', 'traefik', 'compose.yml');
  if (fs.existsSync(own)) docker('compose', '-p', 'bm-traefik', '-f', own, 'up', '-d');
}
