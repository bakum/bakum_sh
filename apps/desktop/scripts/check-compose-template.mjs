// D72: runtime.composeTemplate. The sandbox template adds redis next to Odoo and an env variable to the build service;
// the build must come up with both, the app must keep treating Odoo as the build container, an edit of the template must
// mark the build «конфигурация изменилась» and «Применить» must take it, deleting the project must remove redis too.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { launch, bm } from './pw.mjs';
import { SANDBOX, ensureSandbox, waitJob, waitJobs, branch, lastBuild } from './sandbox.mjs';

const ID = 'bmtpl';
const TPL = `${SANDBOX}/bm-compose.yml`;
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const pause = (ms = 3000) => new Promise((r) => setTimeout(r, ms));
const containers = (...filters) => docker('ps', '-a', ...filters.flatMap((f) => ['--filter', `label=${f}`]), '--format', '{{.Names}}').split('\n').filter(Boolean);
const writeTpl = (marker) =>
  fs.writeFileSync(
    TPL,
    [
      'services:',
      '  odoo:',
      '    environment:',
      `      BM_TPL: "{slug}-${marker}"`,
      '    depends_on: [redis]',
      '  redis:',
      '    image: redis:7',
      '    command: [redis-server, --save, "", --appendonly, "no"]',
      '    volumes: [cache:/data]',
      'volumes:',
      '  cache: {}',
      '',
    ].join('\n'),
  );

async function waitHealthy(name, timeoutMs = 300000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const h = docker('inspect', name, '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}');
    if (h === 'healthy' || Date.now() > until) return h;
    await pause();
  }
}

fs.mkdirSync(SANDBOX, { recursive: true });
writeTpl('v1');

const { app, win } = await launch();
try {
  await ensureSandbox(win, {
    id: ID,
    postgres: 'managed',
    stages: { development: { database: 'fresh', install: { list: ['demz_phone_whatsapp'] }, withDemo: false } },
  });
  await waitJobs(win, ID, 900000);

  const got = await bm(win, 'projects.get', { projectId: ID });
  const doc = YAML.parseDocument(got.yaml);
  doc.setIn(['runtime', 'composeTemplate'], TPL);
  await bm(win, 'projects.update', { projectId: ID, yaml: doc.toString() });

  const br = (await branch(win, ID, 'demz-roman')) ?? (await bm(win, 'branches.add', { projectId: ID, name: 'demz-roman', stage: 'development', build: false }));
  const bj = await waitJob(win, (await bm(win, 'builds.rebuild', { branchId: br.id })).jobId);
  let b = await lastBuild(win, br.id);
  check('сборка с шаблоном', bj.status === 'success' && b.status === 'running', bj.error ?? b.errorMessage ?? '');

  const odoo = containers(`bm.build=${b.id}`, 'com.docker.compose.service=odoo', 'com.docker.compose.oneoff=False')[0];
  const redis = containers(`bm.build=${b.id}`, 'bm.service=redis')[0];
  check('контейнер Odoo здоров', !!odoo && (await waitHealthy(odoo)) === 'healthy', odoo ?? '');
  check('redis запущен рядом', !!redis && docker('inspect', redis, '--format', '{{.State.Status}}') === 'running', redis ?? '');
  if (redis) {
    const labels = JSON.parse(docker('inspect', redis, '--format', '{{json .Config.Labels}}'));
    check('у redis метки владельца и нет маршрута Traefik', labels['bm.project'] === ID && labels['bm.branch'] === String(br.id) && labels['traefik.enable'] === 'false');
    const nets = Object.keys(JSON.parse(docker('inspect', redis, '--format', '{{json .NetworkSettings.Networks}}')));
    check('redis в сети проекта', nets.includes(got.config.runtime.network), nets.join(', '));
  }
  if (odoo) {
    const env = JSON.parse(docker('inspect', odoo, '--format', '{{json .Config.Env}}'));
    check('переменная из шаблона в Odoo', env.includes(`BM_TPL=${br.slug}-v1`), env.find((e) => e.startsWith('BM_TPL=')) ?? 'нет');
    const ping = docker('exec', odoo, 'python3', '-c', "import socket; s=socket.create_connection(('redis', 6379), 5); s.sendall(b'PING\\r\\n'); print(s.recv(16).decode().strip())");
    check('Odoo достаёт до redis по имени сервиса', ping === '+PONG', ping);
  }
  const view = (await bm(win, 'branches.list', { projectId: ID })).development.find((x) => x.id === br.id);
  check('приложение видит сборку запущенной', view?.liveBuild?.status === 'running', view?.liveBuild?.status ?? 'нет');

  // An edit of the template file → «конфигурация изменилась»; «Применить» recreates with it.
  writeTpl('v2');
  await pause(1000);
  // configChanged is computed for the live build of the branch view only.
  const liveOf = async () => (await bm(win, 'branches.list', { projectId: ID })).development.find((x) => x.id === br.id)?.liveBuild;
  check('правка шаблона — «конфигурация изменилась»', (await liveOf())?.configChanged === true);
  const aj = await waitJob(win, (await bm(win, 'builds.action', { buildId: b.id, action: 'apply-config' })).jobId);
  b = await lastBuild(win, br.id);
  const odoo2 = containers(`bm.build=${b.id}`, 'com.docker.compose.service=odoo', 'com.docker.compose.oneoff=False')[0];
  const env2 = odoo2 ? JSON.parse(docker('inspect', odoo2, '--format', '{{json .Config.Env}}')) : [];
  check('«Применить» берёт новый шаблон', aj.status === 'success' && env2.includes(`BM_TPL=${br.slug}-v2`) && (await liveOf())?.configChanged === false, aj.error ?? '');

  // A broken template stops the next apply with a clear message, the running build is left alone.
  fs.writeFileSync(TPL, 'services:\n  redis:\n    container_name: fixed\n');
  const bad = await waitJob(win, (await bm(win, 'builds.action', { buildId: b.id, action: 'apply-config' })).jobId);
  check('сломанный шаблон — понятная ошибка', bad.status === 'failed' && /container_name/.test(bad.error ?? ''), bad.error ?? bad.status);
  check('после ошибки Odoo работает', !!odoo2 && docker('inspect', odoo2, '--format', '{{.State.Status}}') === 'running');
  writeTpl('v2');
} finally {
  try {
    if ((await bm(win, 'projects.list')).some((p) => p.id === ID)) {
      const j = await waitJob(win, (await bm(win, 'projects.delete', { projectId: ID, confirm: ID })).jobId);
      check('песочница удалена', j.status === 'success', j.error ?? '');
      check('контейнеров проекта не осталось (и redis)', containers(`bm.project=${ID}`).length === 0, containers(`bm.project=${ID}`).join(', '));
      const vols = docker('volume', 'ls', '-q', '--filter', `name=bm-${ID}-`).split('\n').filter(Boolean);
      check('том cache удалён', vols.length === 0, vols.join(', '));
    }
  } finally {
    await app.close();
    fs.rmSync(TPL, { force: true });
    const own = path.join(process.env.LOCALAPPDATA, 'Odoo Branch Manager', 'traefik', 'compose.yml');
    if (fs.existsSync(own)) docker('compose', '-p', 'bm-traefik', '-f', own, 'up', '-d');
  }
}
console.log(`Итого: ${results.filter(Boolean).length} из ${results.length}`);
