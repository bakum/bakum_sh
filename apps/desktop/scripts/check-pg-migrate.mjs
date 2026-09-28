// External Postgres: a stopped `db` container is started by the branch Start; «Перевести на свой Postgres» moves the
// project to bm-<id>-db (databases copied, live builds recreated in bm-<id>), the source databases stay.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launch, shot, bm } from './pw.mjs';
import { ensureSandbox, waitJob, waitJobs, branch, lastBuild } from './sandbox.mjs';

const ID = 'pgm';
const SRC = 'odoo19-db';
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const psqlSrc = (sql) => docker('exec', SRC, 'psql', '-U', 'odoo', '-d', 'postgres', '-Atc', sql);
const pause = (ms = 2000) => new Promise((r) => setTimeout(r, ms));
const jobLog = async (win, jobId) => (await bm(win, 'jobs.log', { jobId, tail: 400 })).lines.join('\n');

/** Service container of a build (not the one-off runs). */
const containerOf = (buildId) =>
  docker('ps', '-a', '--filter', `label=bm.build=${buildId}`, '--filter', 'label=com.docker.compose.oneoff=False', '--format', '{{.Names}}').split('\n')[0];

async function waitHealthy(name, timeoutMs = 300000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const h = docker('inspect', name, '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}');
    if (h === 'healthy') return h;
    if (Date.now() > until) return h;
    await pause(3000);
  }
}

let dbName = null;
const { app, win } = await launch();
try {
  await ensureSandbox(win, {
    id: ID,
    stages: { development: { database: 'fresh', install: { list: ['demz_phone_whatsapp'] }, withDemo: false } },
  });
  await waitJobs(win, ID, 600000);
  const br = await branch(win, ID, 'demz-roman');
  await waitJob(win, (await bm(win, 'builds.rebuild', { branchId: br.id })).jobId);
  let b = await lastBuild(win, br.id);
  dbName = b.dbName;
  check('сборка на внешнем Postgres', b.status === 'running', `${b.status} ${dbName}`);

  // 1. Autostart: the user's Postgres container is stopped, Start of the branch starts it first.
  await waitJob(win, (await bm(win, 'builds.action', { buildId: b.id, action: 'stop' })).jobId);
  docker('stop', SRC);
  const sj = await waitJob(win, (await bm(win, 'builds.action', { buildId: b.id, action: 'start' })).jobId);
  const slog = await jobLog(win, sj.jobId ?? sj.id);
  check('Start успешен при остановленном odoo19-db', sj.status === 'success', sj.error ?? '');
  check('в логе запуск контейнера Postgres', slog.includes(`запускаю контейнер ${SRC}`), slog.split('\n').find((l) => l.includes(SRC)) ?? '');
  check('odoo19-db снова работает', docker('inspect', SRC, '--format', '{{.State.Running}}') === 'true');
  check('сборка поднялась', (await waitHealthy(containerOf(b.id))) === 'healthy');

  // 2. Preview and the dialog.
  const pv = await bm(win, 'projects.pgMigratePreview', { projectId: ID });
  check('превью без блокировок', pv.blocker === null, pv.blocker ?? '');
  check('в превью БД сборки', pv.databases.some((d) => d.name === dbName && d.sizeBytes > 0), JSON.stringify(pv.databases));
  check('образ как у odoo19-db', pv.target.image === docker('inspect', SRC, '--format', '{{.Config.Image}}'), pv.target.image);
  check('контейнер-источник найден', pv.source.container === SRC, String(pv.source.container));
  await win.evaluate((h) => (location.hash = h), `#/projects/${ID}/settings/postgres`);
  await win.getByRole('button', { name: 'Перевести на свой Postgres…' }).click();
  await win.getByText('Базы для копирования').waitFor({ timeout: 30000 });
  await shot(win, 'pg-migrate-dialog');

  // 3. The move itself, started from the dialog.
  await win.getByRole('button', { name: 'Перевести', exact: true }).click();
  await win.getByText('ожидание…').or(win.locator('pre')).first().waitFor({ timeout: 30000 });
  const job = (await bm(win, 'jobs.list', { projectId: ID, limit: 5 })).find((j) => j.type === 'migrate_postgres');
  const mj = await waitJob(win, job.id);
  const mlog = await jobLog(win, job.id);
  console.log(mlog);
  check('перевод успешен', mj.status === 'success', mj.error ?? '');
  await win.getByText('Проект работает на своём Postgres.').waitFor({ timeout: 15000 }).catch(() => {});
  check('диалог показывает итог после смены режима', await win.getByText('Проект работает на своём Postgres.').isVisible());
  await shot(win, 'pg-migrate-done');
  await win.getByRole('button', { name: 'Закрыть' }).click();
  await pause(1000);
  check('форма показывает защищённые контейнеры', await win.getByText(`bm-${ID}-db`, { exact: true }).first().isVisible());
  await shot(win, 'pg-migrate-settings');

  const cfg = (await bm(win, 'projects.get', { projectId: ID })).config;
  check('postgres.mode managed', cfg.postgres.mode === 'managed');
  check(`сеть bm-${ID}`, cfg.runtime.network === `bm-${ID}`, cfg.runtime.network);
  check('bm-pgm-db работает', docker('inspect', `bm-${ID}-db`, '--format', '{{.State.Running}}') === 'true');
  b = await lastBuild(win, br.id);
  const cname = containerOf(b.id);
  check('сборка в новой сети', docker('inspect', cname, '--format', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}').trim() === `bm-${ID}`);
  check('сборка здорова на своём Postgres', (await waitHealthy(cname)) === 'healthy');
  check('конфигурация сборки актуальна', !(await bm(win, 'builds.get', { buildId: b.id })).configChanged);
  check('БД на месте в своём Postgres', docker('exec', `bm-${ID}-db`, 'psql', '-U', 'odoo', '-d', 'postgres', '-Atc', `SELECT 1 FROM pg_database WHERE datname='${dbName}'`) === '1');
  check('исходная БД не тронута', psqlSrc(`SELECT 1 FROM pg_database WHERE datname='${dbName}'`) === '1');

  // 4. Stopping the user's stack no longer matters.
  docker('stop', SRC);
  const rj = await waitJob(win, (await bm(win, 'builds.action', { buildId: b.id, action: 'restart' })).jobId);
  check('Restart без odoo19-db', rj.status === 'success' && (await waitHealthy(cname)) === 'healthy', rj.error ?? '');
  check('odoo19-db не трогали', docker('inspect', SRC, '--format', '{{.State.Running}}') === 'false');
  docker('start', SRC);
} finally {
  if (docker('inspect', SRC, '--format', '{{.State.Running}}') !== 'true') docker('start', SRC);
  if ((await bm(win, 'projects.list')).some((p) => p.id === ID)) {
    const j = await waitJob(win, (await bm(win, 'projects.delete', { projectId: ID, confirm: ID })).jobId);
    console.log('песочница удалена:', j.status);
  }
  await app.close();
  // The sandbox profile rewrote the shared bm-traefik with its own networks: the default profile's compose is put back.
  const own = path.join(process.env.LOCALAPPDATA, 'Odoo Branch Manager', 'traefik', 'compose.yml');
  if (fs.existsSync(own)) docker('compose', '-p', 'bm-traefik', '-f', own, 'up', '-d');
  // The copy left in the user's Postgres by the move.
  for (let i = 0; i < 20; i++) {
    try {
      if (dbName) psqlSrc(`DROP DATABASE IF EXISTS "${dbName}"`);
      break;
    } catch {
      await pause(3000);
    }
  }
}
console.log(`Итого: ${results.filter(Boolean).length} из ${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
