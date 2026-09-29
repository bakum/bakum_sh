// Final acceptance on the real DEMZ preset (real profile, no BM_PROFILE), part A — criteria 1 and 3.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { launch, shot, bm, cleanEnv, electronExe, appDir } from './pw.mjs';

const REAL = { BM_PROFILE: '' };
const { app, win } = await launch(REAL);
const info = await win.evaluate(() => window.bm.desktop.info());
console.log('profile:', JSON.stringify(info.profile), 'configDir:', info.configDir);

console.log('=== criterion 1');
await win.waitForSelector('text=Далее: добавить проект', { timeout: 20000 });
await shot(win, 'A1-welcome');
await win.click('text=Далее: добавить проект');
await win.waitForSelector('text=Добавить проект');
await win.fill('input[placeholder*="demz-odoo"]', 'E:/demz-odoo-19/repositories/demz-odoo');
await win.click('button:has-text("Определить")');
await win.waitForSelector('text=Пресет настроек', { timeout: 60000 });
await win.waitForTimeout(1500);
await shot(win, 'A1-detect');
const body = await win.textContent('body');
for (const s of ['DEMZ-UA/demz-odoo', 'demzua, exchange, oca, printer, todoltd', 'demz-odoo-19-odoo', 'demz-odoo-19_default', 'odoo19-db → localhost:5433', 'DEMZ (рекомендуется)']) {
  console.log(body.includes(s) ? 'found  ' : 'MISSING', s);
}
const second = spawn(electronExe, [appDir], { env: cleanEnv(REAL) });
const code = await new Promise((r) => second.on('exit', r));
const mainLog = fs.readFileSync(path.join(info.localDir, 'logs', 'main.log'), 'utf8').trim().split('\n').slice(-3).join('\n');
console.log('second instance exit code', code, '\n' + mainLog);
await win.click('button:has-text("Создать проект")');
await win.waitForURL(/#\/projects\/demz\/branches/, { timeout: 30000 });

console.log('=== criterion 3');
for (let i = 0; i < 60; i++) {
  const s = (await bm(win, 'projects.list'))[0];
  if (s?.lastFetchAt) break;
  await new Promise((r) => setTimeout(r, 2000));
}
await win.waitForTimeout(2000);
const l = await bm(win, 'branches.list', { projectId: 'demz' });
console.log('production :', l.production.map((b) => b.name).join(', '));
console.log('development:', l.development.map((b) => b.name).join(', '));
console.log('not added  :', l.unassigned.map((b) => b.name).join(', ') || '—', '| ignored by rules:', l.ignoredCount);
await shot(win, 'A3-sidebar');
await app.close();
