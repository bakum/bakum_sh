// Odoo backup .zip restored by Core on the host (D61): dump.sql streams into psql through the container's stdin,
// filestore is unpacked straight into the build's folder, then `odoo neutralize`. Sandbox with its own Postgres,
// the newest production backup of E:/demz-odoo-19 (read only). Checks the database, the filestore and that the Docker
// VM logged no new 9p «page allocation failure». Usage: node check-zip-restore.mjs [path-to-backup.zip]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launch, bm } from './pw.mjs';
import { SANDBOX, ensureSandbox, waitJob, waitJobs, branch, lastBuild } from './sandbox.mjs';

const ID = 'bmzip';
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).trim();
const allocFailures = () => docker('run', '--rm', '--privileged', 'alpine', 'sh', '-c', 'dmesg | grep -c "page allocation failure" || true');
const countFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).length : -1);

const failuresBefore = Number(allocFailures());
const { app, win } = await launch();
try {
  const pid = await ensureSandbox(win, { id: ID, postgres: 'managed' });
  await bm(win, 'git.fetch', { projectId: pid });
  await waitJobs(win, pid);
  const prod = await branch(win, pid, '19.0');
  const backups = await bm(win, 'backups.list', { projectId: pid });
  const file = process.argv[2] ?? backups.filter((b) => /\.zip$/i.test(b.name))[0]?.path;
  if (!file) throw new Error('нет .zip в каталоге бэкапов');
  console.log('backup:', file, `${Math.round(fs.statSync(file).size / 1e6)} MB`);
  const t0 = Date.now();
  await bm(win, 'backups.import', { projectId: pid, path: file });
  let last = '';
  await waitJobs(win, pid, 3 * 3600000, async () => {
    const b = await lastBuild(win, prod.id);
    const line = `${b.status} ${b.steps.map((s) => s.name + ':' + s.status[0]).join(' ')}`;
    if (line !== last) console.log(`${Math.round((Date.now() - t0) / 1000)}s ${line}`);
    last = line;
  });
  const b = await lastBuild(win, prod.id);
  console.log('build', b.number, b.status, b.dbName, b.errorMessage ?? '');
  for (const s of b.steps) console.log(' ', s.name, s.status, s.note ?? '');
  check('сборка из .zip поднялась', b.status === 'running', b.errorMessage ?? '');

  const log = fs.readFileSync(path.join(process.env.LOCALAPPDATA, 'Odoo Branch Manager (dev)', 'logs', 'builds', ID, `prod-${b.number}.log`), 'utf8');
  check('dump.sql шёл через psql, не odoo db load', /psql ← dump\.sql/.test(log) && !/odoo db load|Restoring \/bm-backup/.test(log));
  check('в логе есть прогресс dump.sql', /dump\.sql: \d+%/.test(log));

  const db = `bm-${ID}-db`;
  const q = (sql) => docker('exec', db, 'sh', '-c', `psql -U "$POSTGRES_USER" -d ${b.dbName} -tAc "${sql}"`);
  const modules = Number(q("SELECT count(*) FROM ir_module_module WHERE state = 'installed'"));
  check('модули установлены', modules > 0, String(modules));
  check('collation C, как у odoo db load', q(`SELECT datcollate FROM pg_database WHERE datname = '${b.dbName}'`) === 'C');
  const ent = Number(q("SELECT count(*) FROM ir_config_parameter WHERE key IN ('database.enterprise_code','database.expiration_date')"));
  check('нейтрализована: ключей лицензии нет', ent === 0, String(ent));
  const active = Number(q('SELECT count(*) FROM ir_cron WHERE active'));
  console.log('   активных cron после нейтрализации:', active);

  // Every archive file on disk with its size; Odoo adds its own (asset bundles) after the restore.
  const root = `${SANDBOX}/filestore/${b.dbName}`;
  const listed = execFileSync('unzip', ['-Z', '-l', file], { encoding: 'utf8', maxBuffer: 64 << 20 })
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f.length >= 10 && f.at(-1).startsWith('filestore/') && !f.at(-1).endsWith('/'))
    .map((f) => ({ name: f.at(-1).slice('filestore/'.length), size: Number(f[3]) }));
  const missing = listed.filter((f) => !fs.existsSync(`${root}/${f.name}`) || fs.statSync(`${root}/${f.name}`).size !== f.size);
  check('filestore распакован целиком', listed.length > 0 && missing.length === 0, `файлов в архиве ${listed.length}, на диске ${countFiles(root)}, нет или другой размер: ${missing.length}`);
  const stored = Number(q('SELECT count(DISTINCT store_fname) FROM ir_attachment WHERE store_fname IS NOT NULL'));
  console.log('   вложений с store_fname:', stored);

  const code = execFileSync('curl', ['-s', '-o', 'NUL', '-w', '%{http_code}', `${b.url}/web/login`], { encoding: 'utf8' });
  check('HTTP /web/login', code === '200', code);
  const failuresAfter = Number(allocFailures());
  check('в VM нет новых page allocation failure', failuresAfter === failuresBefore, `${failuresBefore} → ${failuresAfter}`);
  console.log('total', Math.round((Date.now() - t0) / 60000), 'min');
} catch (err) {
  check('сценарий', false, err.message);
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
