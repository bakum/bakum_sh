// Milestone 1: first-run wizard → add project on demz-odoo → detection → DEMZ preset proposed (not created).
import { launch, shot } from './pw.mjs';

const { app, win } = await launch();
await win.waitForSelector('text=Далее: добавить проект', { timeout: 20000 });
await shot(win, 'm1-welcome');
await win.click('text=Далее: добавить проект');
await win.waitForSelector('text=Добавить проект');
await win.fill('input[placeholder*="demz-odoo"]', 'E:/demz-odoo-19/repositories/demz-odoo');
await win.click('button:has-text("Определить")');
await win.waitForSelector('text=Пресет настроек', { timeout: 30000 });
await win.waitForTimeout(1500);
await shot(win, 'm1-detect');
const body = await win.textContent('body');
for (const s of ['DEMZ-UA/demz-odoo', 'demz-odoo-19-odoo', 'demz-odoo-19_default', 'odoo19-db', '5433', 'demzua', 'DEMZ (рекомендуется)', '/mnt/repositories/demz-odoo']) {
  console.log(body.includes(s) ? 'OK  ' : 'MISS', s);
}
await win.mouse.wheel(0, 2000);
await win.waitForTimeout(500);
await shot(win, 'm1-detect-yaml');
await app.close();
