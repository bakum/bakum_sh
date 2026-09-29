// D54: DEMZ and Generic builds connect to Postgres with the project's postgres settings, not the db_* of the
// shared odoo.conf. The sandbox mounts a conf whose db_host / db_port / db_user / db_password are all wrong: the build (odoo db init,
// -i of a module, the server itself) must still reach bm-<id>-db.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { launch, bm } from './pw.mjs';
import { httpReq } from './odoo-http.mjs';
import { SANDBOX, ensureSandbox, waitJob, waitJobs, branch, lastBuild } from './sandbox.mjs';

const BAD_CONF = `${SANDBOX}/bad-odoo.conf`;
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

fs.mkdirSync(SANDBOX, { recursive: true });
fs.writeFileSync(BAD_CONF, '[options]\ndb_host = nowhere\ndb_port = 5999\ndb_user = nobody\ndb_password = wrong\n');

// Generic without debugpy is emulated: the stand runs debugpy, and only the plain command went through the entrypoint.
const CASES = [
  { id: 'dbconn', preset: 'demz' },
  { id: 'dbconng', preset: 'generic', plain: true },
];

async function runCase(win, { id, preset, plain }) {
  const tag = plain ? `${preset} без debugpy` : preset;
  await ensureSandbox(win, {
    id,
    preset,
    postgres: 'managed',
    stages: { development: { database: 'fresh', install: { list: ['demz_phone_whatsapp'] }, withDemo: false } },
  });
  await waitJobs(win, id, 900000);

  // 1. What the preset writes.
  const got = await bm(win, 'projects.get', { projectId: id });
  const cmd = got.config.runtime.command;
  const conn = ['--db_host=db', '--db_port=5432', '--db_user=odoo', '--db_password='];
  check(`${tag}: подключение из настроек postgres`, conn.every((a) => cmd.includes(a)), cmd.filter((a) => a.startsWith('--db_')).join(' '));
  const envKeys = Object.keys(got.config.runtime.env);
  check(`${tag}: env без HOST и пароля`, !envKeys.includes('HOST') && !envKeys.includes('PGPASSWORD'), JSON.stringify(envKeys));

  // 2. The shared odoo.conf is replaced with one that points nowhere.
  const doc = YAML.parseDocument(got.yaml);
  const mounts = doc.getIn(['runtime', 'mounts']);
  const confMount = mounts.items.find((m) => m.get('container') === '/etc/odoo/odoo.conf');
  if (confMount) confMount.set('host', BAD_CONF);
  else mounts.add(doc.createNode({ host: BAD_CONF, container: '/etc/odoo/odoo.conf', readOnly: true }));
  if (plain) doc.setIn(['runtime', 'command'], doc.createNode(cmd.slice(cmd.indexOf('/usr/bin/odoo'))));
  await bm(win, 'projects.update', { projectId: id, yaml: doc.toString() });
  const now = (await bm(win, 'projects.get', { projectId: id })).config.runtime.command;
  if (plain) check(`${tag}: команда начинается с /usr/bin/odoo`, now[0] === '/usr/bin/odoo', now.slice(0, 2).join(' '));

  // 3. A build with a fresh database: odoo db init, -i, the server.
  // Generic adds no branches by itself (odoo.sh defaults).
  const br = (await branch(win, id, 'demz-roman')) ?? (await bm(win, 'branches.add', { projectId: id, name: 'demz-roman', stage: 'development', build: false }));
  const bj = await waitJob(win, (await bm(win, 'builds.rebuild', { branchId: br.id })).jobId);
  const b = await lastBuild(win, br.id);
  check(`${tag}: сборка с чужим odoo.conf`, bj.status === 'success' && b.status === 'running', bj.error ?? b.errorMessage ?? '');
  const cname = containerOf(b.id);
  check(`${tag}: контейнер сборки здоров`, !!cname && (await waitHealthy(cname)) === 'healthy');
  if (!cname) return;
  const mounted = docker('inspect', cname, '--format', '{{range .Mounts}}{{if eq .Destination "/etc/odoo/odoo.conf"}}{{.Source}}{{end}}{{end}}');
  check(`${tag}: в контейнере смонтирован чужой conf`, mounted.replace(/\\/g, '/').toLowerCase().endsWith('sandbox/bad-odoo.conf'), mounted);
  const env = JSON.parse(docker('inspect', cname, '--format', '{{json .Config.Env}}')).map((e) => e.split('=')[0]);
  check(`${tag}: PGPASSWORD в env контейнера`, env.includes('PGPASSWORD'));
  check(`${tag}: модуль установлен в БД сборки`, docker('exec', `bm-${id}-db`, 'psql', '-U', 'odoo', '-d', b.dbName, '-Atc', "SELECT state FROM ir_module_module WHERE name='demz_phone_whatsapp'") === 'installed');
  const url = `${b.url}/web/login`;
  const res = await httpReq(url).catch((e) => ({ status: String(e) }));
  check(`${tag}: страница входа отвечает`, res.status === 200, `${url} → ${res.status}`);
}

async function dropSandbox(win, id) {
  if ((await bm(win, 'projects.list')).some((p) => p.id === id)) {
    const j = await waitJob(win, (await bm(win, 'projects.delete', { projectId: id, confirm: id })).jobId);
    console.log(`песочница ${id} удалена:`, j.status);
  }
}

const { app, win } = await launch();
try {
  // One at a time: both sandboxes use the same hosts ({slug}.dev.localhost).
  for (const c of CASES) {
    try {
      await runCase(win, c);
    } finally {
      await dropSandbox(win, c.id);
    }
  }
} finally {
  await app.close();
  fs.rmSync(BAD_CONF, { force: true });
  // The sandbox profile rewrote the shared bm-traefik with its own networks: the default profile's compose is put back.
  const own = path.join(process.env.LOCALAPPDATA, 'Odoo Branch Manager', 'traefik', 'compose.yml');
  if (fs.existsSync(own)) docker('compose', '-p', 'bm-traefik', '-f', own, 'up', '-d');
}
console.log(`Итого: ${results.filter(Boolean).length} из ${results.length}`);
