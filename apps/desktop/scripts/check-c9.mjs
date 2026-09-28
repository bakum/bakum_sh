// Criterion 9 in the sandbox: editing stages.development.idleStopHours in the YAML file by hand is shown in the
// branch Settings as «из стадии»; a branch override — «из ветки»; changing runtime.env marks live builds
// «конфигурация изменилась», and «Применить» recreates the container without rebuilding the database.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { launch, shot, bm } from './pw.mjs';
import { ensureSandbox, waitJobs, branch } from './sandbox.mjs';

const { app, win } = await launch();
const pid = await ensureSandbox(win);
const state = await bm(win, 'system.state');
const file = path.join(state.configDir, 'projects', `${pid}.yaml`);
const roman = await branch(win, pid, 'demz-roman');
const field = async (p) => (await bm(win, 'config.effective', { branchId: roman.id })).fields.find((f) => f.path === p);

const edit = (fn) => {
  const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
  fn(doc);
  fs.writeFileSync(file, doc.toString());
};
edit((d) => d.setIn(['stages', 'development', 'idleStopHours'], 5));
await new Promise((r) => setTimeout(r, 2500));
console.log('after hand edit of the YAML:', JSON.stringify(await field('idleStopHours')));
const ov = (await bm(win, 'config.effective', { branchId: roman.id })).branchOverrides;
await bm(win, 'branches.setOverrides', { branchId: roman.id, overrides: { ...ov, idleStopHours: 2 } });
console.log('after branch override:', JSON.stringify(await field('idleStopHours')));
await win.evaluate((id) => (location.hash = `#/projects/bmdev/branches/${id}/settings`), roman.id);
await win.waitForTimeout(2500);
await win.locator('[data-field="idleStopHours"]').scrollIntoViewIfNeeded();
await shot(win, 'c9-settings-levels');

const live = (await bm(win, 'branches.get', { branchId: roman.id })).liveBuild;
const cidBefore = execFileSync('docker', ['ps', '--filter', `label=bm.build=${live.id}`, '--format', '{{.ID}}'], { encoding: 'utf8' }).trim();
edit((d) => d.setIn(['runtime', 'env', 'BM_CHECK'], String(Date.now())));
await new Promise((r) => setTimeout(r, 2500));
const b1 = await bm(win, 'branches.get', { branchId: roman.id });
console.log('after runtime.env change: configChanged =', b1.liveBuild.configChanged, '| badges:', b1.badges.map((b) => b.kind).join(','));
await win.evaluate((id) => (location.hash = `#/projects/bmdev/branches/${id}/history`), roman.id);
await win.waitForTimeout(2500);
await shot(win, 'c9-config-changed');
await bm(win, 'builds.action', { buildId: live.id, action: 'apply-config' });
await waitJobs(win, pid, 600000);
const b2 = await bm(win, 'branches.get', { branchId: roman.id });
const cidAfter = execFileSync('docker', ['ps', '--filter', `label=bm.build=${live.id}`, '--format', '{{.ID}}'], { encoding: 'utf8' }).trim();
const env = execFileSync('docker', ['inspect', cidAfter, '--format', '{{range .Config.Env}}{{println .}}{{end}}'], { encoding: 'utf8' }).split('\n').find((l) => l.startsWith('BM_CHECK'));
console.log(`after «Применить»: container ${cidBefore} → ${cidAfter}; same build #${b2.liveBuild.number} (${b2.liveBuild.id === live.id}); same DB ${b2.liveBuild.dbName}; configChanged = ${b2.liveBuild.configChanged}; ${env}`);
await app.close();
