// Platform layer (D67) on the current OS: Core starts with the platform folders, connects to Docker, writes the bm
// launchers for this OS and answers bm over its pipe / socket; paths are reported in Status. Dev profile only.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launch, bm, shot } from './pw.mjs';

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const win32 = process.platform === 'win32';
const pause = (ms = 1000) => new Promise((r) => setTimeout(r, ms));

const { app, win } = await launch();
try {
  const info = await win.evaluate(() => window.bm.desktop.info());
  check('platform exposed to the renderer', (await win.evaluate(() => window.bm.platform)) === process.platform);
  check('data folder of the dev profile', info.localDir.endsWith('Odoo Branch Manager (dev)'), info.localDir);
  let status = null;
  for (let i = 0; i < 30; i++) {
    status = await bm(win, 'system.status').catch(() => null);
    if (status?.docker.ok) break;
    await pause();
  }
  check('Docker connected', !!status?.docker.ok, status?.docker.text ?? 'no status');
  check('git found', !!status?.git.ok, status?.git.text ?? '');
  const bin = path.join(info.localDir, 'bin');
  check('bm launcher written', fs.existsSync(path.join(bin, 'bm')));
  check(win32 ? 'bm.cmd written' : 'no bm.cmd outside Windows', fs.existsSync(path.join(bin, 'bm.cmd')) === win32);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = win32
    ? spawnSync('cmd.exe', ['/d', '/c', path.join(bin, 'bm.cmd'), 'version'], { encoding: 'utf8', env })
    : spawnSync('/bin/sh', [path.join(bin, 'bm'), 'version'], { encoding: 'utf8', env });
  check('bm version answers', r.status === 0 && /\d+\.\d+\.\d+/.test(r.stdout), (r.stdout || r.stderr).trim());
  await shot(win, 'check-platform');
} finally {
  await app.close();
  // The dev profile rewrites the shared bm-traefik with its own networks: give it back to the default profile.
  const base = win32 ? process.env.LOCALAPPDATA : path.join(process.env.HOME, '.local', 'share');
  const own = path.join(base, 'Odoo Branch Manager', 'traefik', 'compose.yml');
  if (fs.existsSync(own)) execFileSync('docker', ['compose', '-p', 'bm-traefik', '-f', own, 'up', '-d'], { stdio: 'ignore' });
}
console.log(`Итого: ${results.filter(Boolean).length} из ${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
