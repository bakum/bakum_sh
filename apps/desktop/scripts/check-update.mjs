// Update check / install flow against a local fake GitHub release feed (unpackaged build, BM_UPDATE_URL +
// BM_UPDATE_DRY_RUN=1: the installer is downloaded and verified, the app closes completely, the installer is
// "started" in dry-run mode). The native confirmation dialog is answered through Electron's main process.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch, shot, bm } from './pw.mjs';

const payload = crypto.randomBytes(3 * 1024 * 1024);
const sha = crypto.createHash('sha256').update(payload).digest('hex');
let feedVersion = '9.9.9';
let digest = `sha256:${sha}`;
const server = http.createServer((req, res) => {
  const port = server.address().port;
  if (req.url === '/releases') {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify([
        { tag_name: 'v99.0.0-rc.1', name: 'rc', body: '', html_url: 'https://github.com/bakum/bakum_sh/releases', draft: false, prerelease: true, published_at: '2026-09-28T12:00:00Z', assets: [] },
        {
          tag_name: `v${feedVersion}`,
          name: `Odoo Branch Manager v${feedVersion}`,
          body: '## Что нового\n- Тестовый релиз для проверки обновлений',
          html_url: `https://github.com/bakum/bakum_sh/releases/tag/v${feedVersion}`,
          draft: false,
          prerelease: false,
          published_at: '2026-09-28T12:00:00Z',
          assets: [{ name: `Odoo-Branch-Manager-Setup-${feedVersion}.exe`, size: payload.length, digest, browser_download_url: `http://127.0.0.1:${port}/setup.exe` }],
        },
      ]),
    );
  } else if (req.url === '/setup.exe') {
    res.setHeader('content-length', payload.length);
    res.end(payload);
  } else res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const env = { BM_UPDATE_URL: `http://127.0.0.1:${server.address().port}/releases`, BM_UPDATE_DRY_RUN: '1' };
const stateOf = (win) => win.evaluate(() => window.bm.desktop.update.get());
const target = path.join(os.tmpdir(), 'odoo-branch-manager-update', 'Odoo-Branch-Manager-Setup-9.9.9.exe');
fs.rmSync(target, { force: true });

console.log('=== up to date');
feedVersion = '0.0.1';
let { app, win } = await launch(env);
let s = await win.evaluate(() => window.bm.desktop.update.check());
console.log('manual check →', s.status, 'latest', s.latest, 'current', s.current);
await app.close();

console.log('\n=== startup check finds a newer version');
feedVersion = '9.9.9';
({ app, win } = await launch(env));
await win.waitForSelector('[data-testid="update-banner"]', { timeout: 30000 });
s = await stateOf(win);
console.log('startup →', s.status, s.latest, 'asset', JSON.stringify(s.asset), 'pre-release ignored:', s.latest !== '99.0.0-rc.1');
console.log('banner:', (await win.textContent('[data-testid="update-banner"]')).slice(0, 90));
console.log('footer:', await win.textContent('[data-testid="footer-update"]'));
await shot(win, 'update-banner');
await win.evaluate(() => (location.hash = '#/settings/app'));
await win.waitForTimeout(1500);
await shot(win, 'update-settings');

console.log('\n=== tampered installer is rejected');
digest = 'sha256:' + '0'.repeat(64);
await win.evaluate(() => window.bm.desktop.update.check());
await app.evaluate(({ dialog }) => {
  dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
});
let r = await win.evaluate(() => window.bm.desktop.update.install());
console.log('install →', JSON.stringify(r), '| status', (await stateOf(win)).status, '| file kept:', fs.existsSync(target));

console.log('\n=== accepted update: download, verify, close the app, start the installer');
digest = `sha256:${sha}`;
await win.evaluate(() => window.bm.desktop.update.check());
const info = await win.evaluate(() => window.bm.desktop.info());
const exited = new Promise((res) => app.process().once('exit', (code) => res(code)));
void win.evaluate(() => window.bm.desktop.update.install()).catch(() => {});
const code = await Promise.race([exited, new Promise((res) => setTimeout(() => res('timeout'), 60000))]);
console.log('app process exit:', code);
const file = fs.existsSync(target) ? crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') === sha : false;
console.log('installer downloaded and matches SHA-256:', file);
console.log(
  fs
    .readFileSync(path.join(info.localDir, 'logs', 'main.log'), 'utf8')
    .split('\n')
    .filter((l) => /update/.test(l))
    .slice(-4)
    .join('\n'),
);
server.close();
fs.rmSync(target, { force: true });
