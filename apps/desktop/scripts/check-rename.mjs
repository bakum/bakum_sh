// After the rename: the real profile's folders are migrated, the project and live builds are intact,
// the footer shows version and copyright.
import fs from 'node:fs';
import path from 'node:path';
import { launch, shot, bm } from './pw.mjs';

const { app, win } = await launch({ BM_PROFILE: '' });
const info = await win.evaluate(() => window.bm.desktop.info());
console.log('info:', JSON.stringify({ version: info.version, commit: info.commit, buildDate: info.buildDate, configDir: info.configDir, localDir: info.localDir }));
console.log('migration log:', fs.readFileSync(path.join(info.localDir, 'logs', 'main.log'), 'utf8').split('\n').filter((l) => /renamed from|starting/.test(l)).slice(-3).join('\n'));
const projects = await bm(win, 'projects.list');
console.log('projects:', projects.map((p) => p.id).join(', '));
const l = await bm(win, 'branches.list', { projectId: 'demz' });
const prod = l.production[0];
console.log('prod live:', prod.liveBuild?.status, prod.liveBuild?.containerState, prod.url);
const st = await bm(win, 'system.status', { refresh: true });
console.log('traefik:', st.traefik.text, '| discrepancies:', st.discrepancies.length, '| orphans:', st.orphans.length);
const logs = await bm(win, 'logs.read', { buildId: prod.liveBuild.id, kind: 'build', tail: 1 });
console.log('build log path after migration:', logs.path, fs.existsSync(logs.path));
console.log('footer:', await win.textContent('[data-testid="app-footer"]'));
await win.evaluate((id) => (location.hash = `#/projects/demz/branches/${id}/history`), prod.id);
await win.waitForTimeout(2500);
await shot(win, 'rename-footer');
console.log('title:', await win.title());
await app.close();
