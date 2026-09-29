// Snapshots (spec 8.9 Backups, D42) on a tiny «Odoo in Docker» project (own Postgres, odoo:19.0): create → change the
// database and the filestore → roll back (the state before is kept as a snapshot) → export the live database and a
// snapshot to Odoo .zip → delete a snapshot → import the exported .zip into Production (the old database goes, and its
// snapshots with it).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { launch, bm, shot } from './pw.mjs';
import { SANDBOX, waitJob, waitJobs, branch, lastBuild } from './sandbox.mjs';
import { httpReq } from './odoo-http.mjs';

const ID = 'bmsnap';
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=bm', '-c', 'user.email=bm@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
const pause = (ms = 2000) => new Promise((r) => setTimeout(r, ms));
const sql = (db, q) => docker('exec', `bm-${ID}-db`, 'psql', '-U', 'odoo', '-d', db, '-Atc', q);
const dbExists = (db) => sql('postgres', `SELECT count(*) FROM pg_database WHERE datname='${db}'`) === '1';
const ROOT = `${SANDBOX}/${ID}`;
const WORK = `${ROOT}/work`;
const FS = `${ROOT}/filestore`;
const marker = (db) => sql(db, "SELECT value FROM ir_config_parameter WHERE key='bm.check'");

function makeOrigin() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(`${WORK}/addons/bm_probe`, { recursive: true });
  fs.writeFileSync(`${WORK}/addons/bm_probe/__manifest__.py`, `{'name': 'BM probe', 'version': '19.0.1.0.0', 'depends': ['base'], 'license': 'LGPL-3'}\n`);
  fs.writeFileSync(`${WORK}/addons/bm_probe/__init__.py`, '');
  fs.writeFileSync(`${WORK}/modules_to_install.txt`, 'bm_probe\n');
  fs.writeFileSync(`${WORK}/.gitignore`, '__pycache__/\n*.pyc\n');
  git(ROOT, 'init', '-q', '-b', 'main', 'work');
  git(WORK, 'add', '-A');
  git(WORK, 'commit', '-q', '-m', 'probe');
  git(ROOT, 'clone', '-q', '--bare', 'work', 'origin.git');
  return `file:///${ROOT}/origin.git`;
}

/** HTTP status of /web/login, waiting up to 90 s for Odoo to start after the container was started again. */
async function loginStatus(url) {
  let last = 0;
  for (let i = 0; i < 45; i++) {
    last = (await httpReq(`${url}/web/login`).catch(() => ({ status: 0 }))).status;
    if (last === 200) return last;
    await pause(2000);
  }
  return last;
}

async function job(win, ref) {
  const j = await waitJob(win, ref.jobId);
  return j;
}

async function run(win) {
  const url = makeOrigin();
  const c = await bm(win, 'repo.clone', { url, mirror: true, shallow: false });
  check('копия репозитория', (await waitJob(win, c.jobId)).status === 'success');
  const d = await bm(win, 'projects.detect', { mirror: c.dir, url });
  const cfg = structuredClone(d.proposals.odoo);
  Object.assign(cfg, { id: ID, name: 'Snapshots check' });
  cfg.naming.db = `bm_${ID}_{slug_}_{build}`;
  cfg.naming.host = `{slug}.${ID}.localhost`;
  cfg.runtime.network = `bm-${ID}`;
  cfg.postgres.protectedContainers = [`bm-${ID}-db`];
  cfg.repo.worktreesDir = `${ROOT}/worktrees`;
  cfg.runtime.filestore.hostDir = FS;
  cfg.production.backups.dir = null;
  await bm(win, 'projects.create', { yaml: YAML.stringify(cfg) });
  await waitJobs(win, ID, 900000);
  let prodBr = null;
  for (let i = 0; i < 60 && !prodBr; i++) {
    prodBr = await branch(win, ID, 'main');
    if (!prodBr) await pause();
  }
  const pj = await waitJob(win, (await bm(win, 'builds.rebuild', { branchId: prodBr.id })).jobId);
  const prod = await lastBuild(win, prodBr.id);
  check('Production собрана', pj.status === 'success' && prod.status === 'running', prod.errorMessage ?? '');
  const db = prod.dbName;

  // 1. Snapshot of the state «before».
  sql(db, "INSERT INTO ir_config_parameter (key, value, create_date, write_date) VALUES ('bm.check', 'before', now(), now())");
  fs.mkdirSync(`${FS}/${db}/zz`, { recursive: true });
  fs.writeFileSync(`${FS}/${db}/zz/before.txt`, 'before');
  const j1 = await job(win, await bm(win, 'snapshots.create', { branchId: prodBr.id, name: 'first' }));
  let snaps = await bm(win, 'snapshots.list', { branchId: prodBr.id });
  const first = snaps.find((s) => s.name === 'first');
  check('снапшот создан', j1.status === 'success' && !!first && first.dbName === `${db}_snap_1`, j1.error ?? JSON.stringify(snaps));
  check('снапшот: данные и filestore', marker(first.dbName) === 'before' && fs.existsSync(`${FS}/${first.dbName}/zz/before.txt`));
  check('снапшот: размер посчитан', (first.sizeBytes ?? 0) > 0, String(first.sizeBytes));
  const s1 = await loginStatus(prod.url);
  check('сборка снова работает', s1 === 200, `${prod.url} → ${s1}`);

  // 2. Change, then roll back.
  sql(db, "UPDATE ir_config_parameter SET value = 'after' WHERE key = 'bm.check'");
  fs.rmSync(`${FS}/${db}/zz/before.txt`);
  fs.writeFileSync(`${FS}/${db}/zz/after.txt`, 'after');
  const j2 = await job(win, await bm(win, 'snapshots.restore', { snapshotId: first.id }));
  check('откат выполнен', j2.status === 'success', j2.error ?? '');
  check('откат: данные «before»', marker(db) === 'before');
  check('откат: filestore', fs.existsSync(`${FS}/${db}/zz/before.txt`) && !fs.existsSync(`${FS}/${db}/zz/after.txt`));
  snaps = await bm(win, 'snapshots.list', { branchId: prodBr.id });
  const keep = snaps.find((s) => s.name.startsWith('Перед откатом'));
  check('состояние до отката сохранено', !!keep && marker(keep.dbName) === 'after' && fs.existsSync(`${FS}/${keep.dbName}/zz/after.txt`), JSON.stringify(snaps.map((s) => s.name)));
  const s2 = await loginStatus(prod.url);
  check('сборка работает после отката', s2 === 200, `${prod.url} → ${s2}`);

  // 3. Export the live database and a snapshot.
  const liveZip = `${ROOT}/export-live.zip`;
  const j3 = await job(win, await bm(win, 'snapshots.export', { branchId: prodBr.id, path: liveZip }));
  const isZip = (f) => fs.existsSync(f) && fs.readFileSync(f).subarray(0, 2).toString() === 'PK';
  check('выгрузка живой БД в .zip', j3.status === 'success' && isZip(liveZip), j3.error ?? '');
  const snapZip = `${ROOT}/export-snap.zip`;
  const j4 = await job(win, await bm(win, 'snapshots.export', { branchId: prodBr.id, snapshotId: keep.id, path: snapZip }));
  check('выгрузка снапшота в .zip', j4.status === 'success' && isZip(snapZip), j4.error ?? '');
  check('временные файлы выгрузки удалены', !fs.readdirSync(path.join(process.env.LOCALAPPDATA, 'Odoo Branch Manager (dev)', 'exports')).some((f) => f.startsWith(db)));

  // 4. Delete a snapshot.
  const j5 = await job(win, await bm(win, 'snapshots.delete', { snapshotId: keep.id }));
  check('снапшот удалён', j5.status === 'success' && !dbExists(keep.dbName) && !fs.existsSync(`${FS}/${keep.dbName}`), j5.error ?? '');
  await win.evaluate(([pid, id]) => (location.hash = `#/projects/${pid}/branches/${id}/backups`), [ID, prodBr.id]);
  await win.waitForTimeout(2500);
  check('вкладка Backups: таблица снапшотов', (await win.locator('[data-testid^="snapshot-"]').count()) >= 1);
  await shot(win, 'snapshots');

  // 5. The exported .zip as a production backup: the old database goes, and its snapshots with it.
  const ij = await waitJob(win, (await bm(win, 'backups.import', { projectId: ID, path: liveZip })).jobId);
  const imp = await lastBuild(win, prodBr.id);
  check('импорт выгрузки в Production', ij.status === 'success' && imp.status === 'running', ij.error ?? imp.errorMessage ?? '');
  check('в новой БД данные «before»', marker(imp.dbName) === 'before');
  check('снапшоты прежней БД удалены вместе с ней', !dbExists(db) && !dbExists(first.dbName) && !fs.existsSync(`${FS}/${first.dbName}`));
  check('у новой БД снапшотов нет', (await bm(win, 'snapshots.list', { branchId: prodBr.id })).length === 0);
}

const { app, win } = await launch();
try {
  const state = await bm(win, 'system.state');
  if (state.firstRun) await bm(win, 'system.completeFirstRun', {});
  await run(win);
} catch (err) {
  check('без исключений', false, err.stack ?? err.message);
} finally {
  if ((await bm(win, 'projects.list')).some((p) => p.id === ID)) {
    const j = await waitJob(win, (await bm(win, 'projects.delete', { projectId: ID, confirm: ID })).jobId);
    console.log(`проект ${ID} удалён: ${j.status}`);
  }
  await app.close();
  const own = path.join(process.env.LOCALAPPDATA, 'Odoo Branch Manager', 'traefik', 'compose.yml');
  if (fs.existsSync(own)) docker('compose', '-p', 'bm-traefik', '-f', own, 'up', '-d');
}
console.log(`Итого: ${results.filter(Boolean).length} из ${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
