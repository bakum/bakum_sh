// Screenshots of the odoo.sh slate in the light scheme (D68): dark branch sidebar and branch header with tabs, light
// content. The dark scheme is shot too, it must stay as it was. Sandbox project, deleted at the end.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launch, bm, shot } from './pw.mjs';
import { ensureSandbox, waitJob, waitJobs } from './sandbox.mjs';

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).trim();
const { app, win } = await launch();
let id = null;
try {
  await win.setViewportSize({ width: 1600, height: 950 });
  id = await ensureSandbox(win);
  await waitJobs(win, id, 600000);
  for (const scheme of ['light', 'dark']) {
    await win.evaluate((s) => localStorage.setItem('bm-color-scheme', s), scheme);
    await win.evaluate((h) => (location.hash = h), `#/projects/${id}/branches`);
    await win.reload();
    await win.waitForTimeout(3000);
    const list = await bm(win, 'branches.list', { projectId: id });
    const first = list.production[0] ?? list.development[0];
    if (first) {
      await win.evaluate((h) => (location.hash = h), `#/projects/${id}/branches/${first.id}/history`);
      await win.waitForTimeout(2500);
      await win.locator('.mantine-Tabs-tab').nth(2).hover();
      await shot(win, `slate-${scheme}-history`);
      await win.evaluate(() => (location.hash = location.hash.replace(/\/[a-z]+$/, '/settings')));
      await win.waitForTimeout(2500);
      await shot(win, `slate-${scheme}-settings`);
    } else {
      await shot(win, `slate-${scheme}-branches`);
    }
  }
} finally {
  if (id) {
    const j = await waitJob(win, (await bm(win, 'projects.delete', { projectId: id, confirm: id })).jobId);
    console.log('sandbox deleted:', j.status);
  }
  await app.close();
  const own = path.join(process.env.LOCALAPPDATA, 'Odoo Branch Manager', 'traefik', 'compose.yml');
  if (fs.existsSync(own)) docker('compose', '-p', 'bm-traefik', '-f', own, 'up', '-d');
}
