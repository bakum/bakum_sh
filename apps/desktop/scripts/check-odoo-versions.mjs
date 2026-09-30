// Odoo 16–18 in the «Odoo in Docker» preset (D38): for each series a tiny repository with one module, a project from
// the wizard's proposal, Production (no demo) and Development (demo) builds, then a backup of Production restored
// with neutralization (D61: dump.sql through psql, then `odoo neutralize`). Pulls odoo:16.0 / 17.0 / 18.0.
// Usage: node check-odoo-versions.mjs [16.0 17.0 …]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { launch, bm } from './pw.mjs';
import { SANDBOX, waitJob, waitJobs, branch, lastBuild } from './sandbox.mjs';
import { httpReq } from './odoo-http.mjs';

const VERSIONS = process.argv.slice(2).length ? process.argv.slice(2) : ['16.0', '17.0', '18.0'];
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=bm', '-c', 'user.email=bm@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
const pause = (ms = 3000) => new Promise((r) => setTimeout(r, ms));
const containerOf = (buildId) =>
  docker('ps', '-a', '--filter', `label=bm.build=${buildId}`, '--filter', 'label=com.docker.compose.oneoff=False', '--format', '{{.Names}}').split('\n')[0];
const sql = (id, db, q) => docker('exec', `bm-${id}-db`, 'psql', '-U', 'odoo', '-d', db, '-Atc', q);

/** Bare repository `shop<NN>.git` with branches main and feature; the module version carries the series. */
function makeOrigin(version) {
  const major = version.split('.')[0];
  const root = `${SANDBOX}/ov${major}`;
  fs.rmSync(root, { recursive: true, force: true });
  const work = `${root}/work`;
  fs.mkdirSync(`${work}/addons/bm_probe`, { recursive: true });
  fs.writeFileSync(
    `${work}/addons/bm_probe/__manifest__.py`,
    `{'name': 'BM probe', 'version': '${version}.1.0.0', 'depends': ['base'], 'license': 'LGPL-3', 'installable': True}\n`,
  );
  fs.writeFileSync(`${work}/addons/bm_probe/__init__.py`, '');
  fs.writeFileSync(`${work}/modules_to_install.txt`, 'bm_probe\n');
  // Odoo writes __pycache__ into the mounted worktree; without this the next build finds it dirty.
  fs.writeFileSync(`${work}/.gitignore`, '__pycache__/\n*.pyc\n');
  git(root, 'init', '-q', '-b', 'main', 'work');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'probe');
  git(work, 'branch', 'feature');
  git(root, 'clone', '-q', '--bare', 'work', `shop${major}.git`);
  return `file:///${root}/shop${major}.git`;
}

async function waitBranches(win, id, names, timeoutMs = 120000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const found = await Promise.all(names.map((n) => branch(win, id, n)));
    if (found.every(Boolean)) return found;
    if (Date.now() > until) throw new Error(`ветки ${names.join(', ')} не появились`);
    await pause(2000);
  }
}

async function build(win, id, br, label) {
  const j = await waitJob(win, (await bm(win, 'builds.rebuild', { branchId: br.id })).jobId);
  const b = await lastBuild(win, br.id);
  check(`${label}: сборка`, j.status === 'success' && b.status === 'running', j.error ?? b.errorMessage ?? '');
  if (b.status !== 'running') return null;
  const r = await httpReq(`${b.url}/web/login`).catch((e) => ({ status: String(e) }));
  check(`${label}: /web/login через Traefik`, r.status === 200, String(r.status));
  check(`${label}: bm_probe установлен`, sql(id, b.dbName, "SELECT state FROM ir_module_module WHERE name='bm_probe'") === 'installed');
  return b;
}

async function checkVersion(win, version) {
  const major = version.split('.')[0];
  const id = `ov${major}`;
  console.log(`\n=== Odoo ${version} (${id}) ===`);
  const url = makeOrigin(version);
  const c = await bm(win, 'repo.clone', { url, mirror: true, shallow: false });
  const cj = await waitJob(win, c.jobId);
  check('копия репозитория', cj.status === 'success', cj.error ?? '');

  // 1. The wizard: series from the manifests, the matching image, no mismatch warning.
  const d = await bm(win, 'projects.detect', { mirror: c.dir, url });
  const cfg = structuredClone(d.proposals.odoo);
  check('серия по манифестам', d.odooVersion === version, d.odooVersion);
  check('образ', cfg.runtime.image === `odoo:${version}`, cfg.runtime.image);
  check('нет предупреждения о версии', !d.warnings.some((w) => /рассчитаны на Odoo/.test(w)), d.warnings.join(' | '));
  const other = await bm(win, 'projects.detect', { mirror: c.dir, url, odoo: { version: version === '19.0' ? '18.0' : '19.0' } });
  check('предупреждение при другой версии', other.warnings.some((w) => w.includes(`рассчитаны на Odoo ${version}, а выбрана`)), other.warnings.join(' | '));

  cfg.id = id;
  cfg.name = `Odoo ${version} check`;
  cfg.naming.db = `bm_${id}_{slug_}_{build}`;
  cfg.naming.host = `{slug}.${id}.localhost`;
  cfg.runtime.network = `bm-${id}`;
  cfg.postgres.protectedContainers = [`bm-${id}-db`];
  cfg.repo.worktreesDir = `${SANDBOX}/${id}/worktrees`;
  cfg.runtime.filestore.hostDir = `${SANDBOX}/${id}/filestore`;
  cfg.production.backups.dir = null;
  await bm(win, 'projects.create', { yaml: YAML.stringify(cfg) });
  await waitJobs(win, id, 900000);
  const [prodBr, devBr] = await waitBranches(win, id, ['main', 'feature']);
  check('стадии веток', prodBr.stage === 'production' && devBr.stage === 'development', `${prodBr.stage} / ${devBr.stage}`);

  // 2. Production without demo, Development with demo (the base module's demo flag of the database).
  const prod = await build(win, id, prodBr, 'Production');
  if (prod) check('Production без демо', sql(id, prod.dbName, "SELECT demo FROM ir_module_module WHERE name='base'") === 'f');
  const dev = await build(win, id, devBr, 'Development');
  if (dev) check('Development с демо', sql(id, dev.dbName, "SELECT demo FROM ir_module_module WHERE name='base'") === 't');

  // 3. A backup of Production (`odoo db dump`) restored with neutralization (D61).
  if (prod) {
    const cname = containerOf(prod.id);
    const inC = `/tmp/${id}-backup.zip`;
    docker('exec', cname, 'sh', '-c', `odoo db -D /var/lib/odoo --db_host=db --db_port=5432 -r odoo -w "$PASSWORD" dump ${prod.dbName} ${inC}`);
    const file = path.join(SANDBOX, id, 'backup.zip');
    docker('cp', `${cname}:${inC}`, file);
    check('дамп Production', fs.existsSync(file) && fs.statSync(file).size > 0);
    const ij = await waitJob(win, (await bm(win, 'backups.import', { projectId: id, path: file })).jobId);
    const b = await lastBuild(win, prodBr.id);
    check('импорт бэкапа .zip', ij.status === 'success' && b.status === 'running', ij.error ?? b.errorMessage ?? '');
    if (b.status === 'running') {
      const neutralized = sql(id, b.dbName, "SELECT value FROM ir_config_parameter WHERE key='database.is_neutralized'");
      check('БД нейтрализована', neutralized.toLowerCase() === 'true', neutralized || '(нет параметра)');
      check('bm_probe в восстановленной БД', sql(id, b.dbName, "SELECT state FROM ir_module_module WHERE name='bm_probe'") === 'installed');
    }
  }
}

const { app, win } = await launch();
try {
  const state = await bm(win, 'system.state');
  if (state.firstRun) await bm(win, 'system.completeFirstRun', {});
  for (const v of VERSIONS) {
    try {
      await checkVersion(win, v);
    } catch (err) {
      check(`Odoo ${v}: без исключений`, false, err.message);
    } finally {
      const id = `ov${v.split('.')[0]}`;
      if ((await bm(win, 'projects.list')).some((p) => p.id === id)) {
        const j = await waitJob(win, (await bm(win, 'projects.delete', { projectId: id, confirm: id })).jobId);
        console.log(`проект ${id} удалён: ${j.status}`);
      }
    }
  }
} finally {
  await app.close();
  // The dev profile rewrote the shared bm-traefik with its own networks: the default profile's compose is put back.
  const own = path.join(process.env.LOCALAPPDATA, 'Odoo Branch Manager', 'traefik', 'compose.yml');
  if (fs.existsSync(own)) docker('compose', '-p', 'bm-traefik', '-f', own, 'up', '-d');
}
console.log(`Итого: ${results.filter(Boolean).length} из ${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
