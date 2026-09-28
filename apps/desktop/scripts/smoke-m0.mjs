// Milestone 0 smoke: window < 2 s, second instance exits, Core restart after taskkill shows banner.
import { _electron as electron } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronExe = path.resolve(appDir, '../../node_modules/electron/dist/electron.exe');
const shots = process.env.SHOTS ?? path.join(appDir, '../../tmp');
const env = { ...process.env, BM_PROFILE: process.env.BM_PROFILE ?? 'dev' };
delete env.ELECTRON_RUN_AS_NODE;

const t0 = Date.now();
const app = await electron.launch({ executablePath: electronExe, args: [appDir], env });
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
console.log('window-ms', Date.now() - t0);
await win.waitForSelector('text=Core pid', { timeout: 10000 });
console.log('ping:', await win.textContent('body'));

// second instance must exit immediately
const t1 = Date.now();
const second = spawn(electronExe, [appDir], { env });
const code = await new Promise((r) => second.on('exit', r));
console.log('second-instance exit', code, 'ms', Date.now() - t1);

// kill Core
const info = await win.evaluate(() => window.bm.desktop.info());
console.log('core pid', info.corePid);
execFileSync('taskkill', ['/F', '/PID', String(info.corePid)]);
await win.waitForSelector('text=Core был перезапущен', { timeout: 15000 });
const info2 = await win.evaluate(() => window.bm.desktop.info());
console.log('core restarted, new pid', info2.corePid);
await win.waitForSelector(`text=Core pid ${info2.corePid}`, { timeout: 10000 });
await win.screenshot({ path: path.join(shots, 'm0.png') });
await app.close().catch(() => {});
process.exit(0);
