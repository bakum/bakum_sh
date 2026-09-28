// New projects get the app's own Postgres (postgres.mode: managed) in every preset. DEMZ keeps the user and password of
// the stack's odoo.conf, so its builds connect to bm-<id>-db without any change of odoo.conf.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launch, bm } from './pw.mjs';
import { ORIGIN_URL, ensureSandbox, waitJob, waitJobs, branch, lastBuild } from './sandbox.mjs';

const ID = 'nmg';
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const pause = (ms = 3000) => new Promise((r) => setTimeout(r, ms));
const containerOf = (buildId) =>
  docker('ps', '-a', '--filter', `label=bm.build=${buildId}`, '--filter', 'label=com.docker.compose.oneoff=False', '--format', '{{.Names}}').split('\n')[0];

async function waitHealthy(name, timeoutMs = 300000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const h = docker('inspect', name, '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}');
    if (h === 'healthy' || Date.now() > until) return h;
    await pause();
  }
}

const { app, win } = await launch();
try {
  // 1. What the wizard proposes.
  const r = await bm(win, 'repo.clone', { url: ORIGIN_URL, mirror: true, shallow: false });
  const cj = await waitJob(win, r.jobId);
  check('копия репозитория', cj.status === 'success', cj.error ?? '');
  const d = await bm(win, 'projects.detect', { mirror: r.dir, url: ORIGIN_URL, folder: 'E:/demz-odoo-19/repositories/demz-odoo' });
  const srcImage = docker('inspect', 'odoo19-db', '--format', '{{.Config.Image}}');
  for (const p of ['demz', 'generic', 'odoo']) {
    const pg = d.proposals[p].postgres;
    check(`пресет ${p}: managed`, pg.mode === 'managed', `${pg.mode} ${pg.image} :${pg.port} сеть ${d.proposals[p].runtime.network}`);
  }
  check('DEMZ: образ найденного Postgres', d.proposals.demz.postgres.image === srcImage, d.proposals.demz.postgres.image);
  check('DEMZ: своя сеть', d.proposals.demz.runtime.network === `bm-${d.proposals.demz.id}`, d.proposals.demz.runtime.network);
  check('DEMZ: пользователь и хост из стенда', d.proposals.demz.postgres.user === 'odoo' && d.proposals.demz.postgres.internalHost === 'db');

  // 2. The project is created and its Postgres prepared.
  await ensureSandbox(win, {
    id: ID,
    mirror: r.dir,
    postgres: 'managed',
    stages: { development: { database: 'fresh', install: { list: ['demz_phone_whatsapp'] }, withDemo: false } },
  });
  await waitJobs(win, ID, 900000);
  const cfg = (await bm(win, 'projects.get', { projectId: ID })).config;
  check('проект создан в режиме managed', cfg.postgres.mode === 'managed' && cfg.runtime.network === `bm-${ID}`, `${cfg.postgres.mode} ${cfg.runtime.network}`);
  const pgName = `bm-${ID}-db`;
  check(`${pgName} работает`, docker('inspect', pgName, '--format', '{{.State.Running}}') === 'true');
  check(`${pgName} в сети bm-${ID}`, docker('inspect', pgName, '--format', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}').trim() === `bm-${ID}`);
  const conf = fs.readFileSync('E:/demz-odoo-19/config/odoo.conf', 'utf8').match(/^\s*db_password\s*=\s*(.+?)\s*$/m)?.[1];
  const envPw = docker('exec', pgName, 'printenv', 'POSTGRES_PASSWORD');
  check('пароль своего Postgres = db_password из odoo.conf', !!conf && envPw === conf);

  // 3. A build on it.
  const br = await branch(win, ID, 'demz-roman');
  const bj = await waitJob(win, (await bm(win, 'builds.rebuild', { branchId: br.id })).jobId);
  const b = await lastBuild(win, br.id);
  check('сборка на своём Postgres', bj.status === 'success' && b.status === 'running', bj.error ?? b.errorMessage ?? '');
  const cname = containerOf(b.id);
  check('контейнер сборки здоров', (await waitHealthy(cname)) === 'healthy');
  check('БД сборки в своём Postgres', docker('exec', pgName, 'psql', '-U', 'odoo', '-d', 'postgres', '-Atc', `SELECT 1 FROM pg_database WHERE datname='${b.dbName}'`) === '1');
} finally {
  if ((await bm(win, 'projects.list')).some((p) => p.id === ID)) {
    const j = await waitJob(win, (await bm(win, 'projects.delete', { projectId: ID, confirm: ID })).jobId);
    console.log('песочница удалена:', j.status);
  }
  await app.close();
  // The sandbox profile rewrote the shared bm-traefik with its own networks: the default profile's compose is put back.
  const own = path.join(process.env.LOCALAPPDATA, 'Odoo Branch Manager', 'traefik', 'compose.yml');
  if (fs.existsSync(own)) docker('compose', '-p', 'bm-traefik', '-f', own, 'up', '-d');
}
console.log(`Итого: ${results.filter(Boolean).length} из ${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
