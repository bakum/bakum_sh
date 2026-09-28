// Milestone 5 UI walk-through: Logs (odoo.log / build.log), Tools, Shell, Editor, Backups, Status, Builds, dark theme.
import { launch, shot } from './pw.mjs';
import { ensureSandbox, branch } from './sandbox.mjs';

const { app, win } = await launch();
const pid = await ensureSandbox(win);
const crm = await branch(win, pid, '19.0-demz-crm');
const prod = await branch(win, pid, '19.0');
const go = async (hash, name, wait = 2500) => {
  await win.evaluate((h) => (location.hash = h), hash);
  await win.waitForTimeout(wait);
  await shot(win, name);
};
await go(`#/projects/${pid}/branches/${crm.id}/logs`, 'm5-logs-odoo', 4000);
await win.click('text=build.log');
await win.waitForTimeout(2500);
await shot(win, 'm5-logs-build');
await go(`#/projects/${pid}/branches/${crm.id}/tools`, 'm5-tools', 4000);
await go(`#/projects/${pid}/branches/${crm.id}/shell`, 'm5-shell');
await go(`#/projects/${pid}/branches/${crm.id}/editor`, 'm5-editor');
await go(`#/projects/${pid}/branches/${prod.id}/backups`, 'm5-backups');
await go(`#/projects/${pid}/builds`, 'm5-builds');
await go('#/status', 'm5-status', 4000);
await go(`#/projects/${pid}/settings/stages`, 'm5-settings-stages');
await go(`#/projects/${pid}/settings/yaml`, 'm5-settings-yaml', 4000);
await win.click('button[aria-label="Тема"]');
await go(`#/projects/${pid}/branches/${crm.id}/history`, 'm5-dark');
await win.click('button[aria-label="Тема"]');
await app.close();
