// Criteria 13 and 15 in the sandbox.
// 13 — closing the window during a build hides it to the tray, the build finishes, a Windows notification is shown,
//      sleep is blocked while the build runs.
// 15 — the app's processes have no listening TCP sockets (checked on a normal launch, without Playwright's CDP port).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { launch, bm, cleanEnv, electronExe, appDir } from './pw.mjs';
import { ensureSandbox, waitJobs, branch, lastBuild } from './sandbox.mjs';

const mainLog = () => fs.readFileSync(path.join(process.env.LOCALAPPDATA, 'Odoo Branch Manager (dev)', 'logs', 'main.log'), 'utf8').split('\n');

console.log('=== criterion 13');
const { app, win } = await launch();
const pid = await ensureSandbox(win);
const roman = await branch(win, pid, 'demz-roman');
const logStart = mainLog().length;
await bm(win, 'builds.rebuild', { branchId: roman.id });
await new Promise((r) => setTimeout(r, 3000));
console.log('during build:', JSON.stringify(await win.evaluate(() => window.bm.desktop.info().then((i) => ({ sleepBlocked: i.sleepBlocked, windowVisible: i.windowVisible })))));
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
await new Promise((r) => setTimeout(r, 1500));
const hidden = await win.evaluate(() => window.bm.desktop.info().then((i) => ({ sleepBlocked: i.sleepBlocked, windowVisible: i.windowVisible })));
console.log('after closing the window:', JSON.stringify(hidden), '| app process alive:', !app.process().killed);
await waitJobs(win, pid, 1800000);
const b = await lastBuild(win, roman.id);
console.log(`build #${b.number}: ${b.status}`);
await new Promise((r) => setTimeout(r, 1500));
console.log('after build:', JSON.stringify(await win.evaluate(() => window.bm.desktop.info().then((i) => ({ sleepBlocked: i.sleepBlocked, windowVisible: i.windowVisible })))));
console.log('main.log:\n' + mainLog().slice(logStart).filter((l) => /notification|sleep/.test(l)).join('\n'));
await app.close();

console.log('\n=== criterion 15');
const child = spawn(electronExe, [appDir], { env: cleanEnv(), stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 15000));
const pids = new Set(
  execFileSync('tasklist', ['/FI', 'IMAGENAME eq electron.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.split('","')[1])
    .filter(Boolean),
);
console.log('electron processes:', [...pids].join(', '));
const listening = execFileSync('netstat', ['-ano'], { encoding: 'utf8' })
  .split(/\r?\n/)
  .filter((l) => /LISTENING/.test(l) && pids.has(l.trim().split(/\s+/).pop()));
console.log('listening sockets of the app:', listening.length ? '\n' + listening.join('\n') : 'none');
execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)]);
