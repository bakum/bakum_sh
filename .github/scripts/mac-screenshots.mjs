// Look at the released macOS app on a GitHub macOS runner (D67): the installed .app is started by Playwright, the main
// screens and the whole desktop (menu bar, Dock) are captured, the bm command line is called over its socket.
// No Docker on these runners, so the app shows «Docker не запущен». Run by .github/workflows/mac-screenshots.yml.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const exe = '/Applications/Odoo Branch Manager.app/Contents/MacOS/Odoo Branch Manager';
const out = process.env.SHOTS_DIR ?? path.join(os.tmpdir(), 'shots');
fs.mkdirSync(out, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await electron.launch({ executablePath: exe, args: [], timeout: 90_000 });
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
const front = () =>
  app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w?.show();
    w?.focus();
  });
const shot = async (name) => {
  await pause(2500);
  await win.screenshot({ path: path.join(out, `${name}.png`) });
  console.log('screenshot', name);
};
const desktop = (name) => {
  try {
    execFileSync('screencapture', ['-x', path.join(out, `${name}.png`)]);
    console.log('screenshot', name, '(desktop)');
  } catch (err) {
    console.log('desktop screenshot failed:', err.message);
  }
};
const go = (route) => win.evaluate((r) => (location.hash = `#${r}`), route);

try {
  await front();
  check('platform in the renderer', (await win.evaluate(() => window.bm.platform)) === 'darwin');
  const info = await win.evaluate(() => window.bm.desktop.info());
  console.log('configDir', info.configDir, '| localDir', info.localDir);
  check('settings in Application Support', info.configDir.includes('/Library/Application Support/Odoo Branch Manager'));
  check('data in ~/.local/share', info.localDir.endsWith('/.local/share/Odoo Branch Manager'));

  let state = null;
  for (let i = 0; i < 60 && !state; i++) {
    state = await win.evaluate(() => window.bm.call('system.state', {})).catch(() => null);
    if (!state) await pause(1000);
  }
  check('Core answers', !!state, state ? `dataDir ${state.dataDir}` : 'no answer in 60 s');
  const menu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((i) => i.label) ?? []);
  check('macOS app menu', menu.length >= 3, menu.join(' | '));

  await shot('01-welcome');
  desktop('02-desktop-welcome');

  if (state?.firstRun) await win.evaluate(() => window.bm.call('system.completeFirstRun', {}));
  await go('/');
  await shot('03-home');
  await go('/projects/new');
  await shot('04-add-project');
  await go('/status');
  await shot('05-status');
  const status = await win.evaluate(() => window.bm.call('system.status', {})).catch((e) => ({ error: e.message }));
  console.log('docker:', JSON.stringify(status.docker ?? status), '| git:', JSON.stringify(status.git ?? null));
  check('git found through PATH', !!status.git?.ok, status.git?.text ?? '');
  await go('/settings/app');
  await shot('06-settings');
  await win.mouse.wheel(0, 1500);
  await shot('07-settings-desktop');
  await front();
  desktop('08-desktop');

  const bmSh = path.join(info.localDir, 'bin', 'bm');
  check('bm launcher, no bm.cmd', fs.existsSync(bmSh) && !fs.existsSync(`${bmSh}.cmd`));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const args of [['version'], ['status']]) {
    const r = spawnSync('/bin/sh', [bmSh, ...args], { encoding: 'utf8', env, timeout: 60_000 });
    console.log(`$ bm ${args.join(' ')} → ${r.status}\n${(r.stdout + r.stderr).trim()}`);
    if (args[0] === 'version') check('bm over the unix socket', r.status === 0, r.stdout.trim());
  }
} finally {
  // Cmd+Q path: before-quit → requestQuit → app.exit; do not wait forever if it hangs.
  await Promise.race([app.close(), pause(15_000)]).catch(() => {});
  app.process()?.kill();
}
console.log(`Итого: ${results.filter(Boolean).length} из ${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
