// Shared Playwright helpers for manual-check scenarios (they drive the real app, nothing is mocked).
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The electron package exports the path of its binary (electron.exe, Electron.app/Contents/MacOS/Electron on macOS).
export const electronExe = createRequire(import.meta.url)('electron');
export const shotsDir = path.resolve(appDir, '../../tmp/shots');
fs.mkdirSync(shotsDir, { recursive: true });

export function cleanEnv(extra = {}) {
  const env = { ...process.env, BM_PROFILE: process.env.BM_PROFILE ?? 'dev', ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export async function launch(extra = {}) {
  const app = await electron.launch({ executablePath: electronExe, args: [appDir], env: cleanEnv(extra), timeout: 30000 });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win };
}

export async function shot(win, name) {
  const p = path.join(shotsDir, `${name}.png`);
  await win.screenshot({ path: p });
  console.log('screenshot', p);
  return p;
}

export async function bm(win, method, params = {}) {
  return win.evaluate(([m, p]) => window.bm.call(m, p), [method, params]);
}
