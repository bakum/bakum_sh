// «Войти как» (D66) on a tiny «Odoo in Docker» project: the dialog lists internal users of the build's database, a
// connect opens a one-off Traefik URL that sets the session cookie of the chosen user and redirects to /web. The URL
// the app would open in the browser is caught in main (shell.openExternal is stubbed) and followed from here.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import YAML from 'yaml';
import { launch, bm, shot } from './pw.mjs';
import { SANDBOX, waitJob, waitJobs, branch } from './sandbox.mjs';

const ID = 'bmconnect';
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const pause = (ms = 2000) => new Promise((r) => setTimeout(r, ms));

const ROOT = `${SANDBOX}/${ID}`;
const WORK = `${ROOT}/work`;
const ORIGIN = `${ROOT}/origin.git`;

function makeOrigin() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(`${WORK}/addons/bm_probe`, { recursive: true });
  fs.writeFileSync(
    `${WORK}/addons/bm_probe/__manifest__.py`,
    "{'name': 'bm_probe', 'version': '19.0.1.0.0', 'depends': ['base'], 'license': 'LGPL-3', 'installable': True}\n",
  );
  fs.writeFileSync(`${WORK}/addons/bm_probe/__init__.py`, '');
  git(ROOT, 'init', '-q', '-b', 'main', 'work');
  git(WORK, 'add', '-A');
  git(WORK, '-c', 'user.name=Ann', '-c', 'user.email=ann@example.com', 'commit', '-q', '-m', 'probe');
  git(ROOT, 'clone', '-q', '--bare', 'work', 'origin.git');
  return `file:///${ORIGIN}`;
}

async function waitBranch(win, name, timeoutMs = 120000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const b = await branch(win, ID, name);
    if (b) return b;
    if (Date.now() > until) throw new Error(`ветка ${name} не появилась`);
    await pause();
  }
}

async function setup(win) {
  const url = makeOrigin();
  const c = await bm(win, 'repo.clone', { url, mirror: true, shallow: false });
  check('копия репозитория', (await waitJob(win, c.jobId)).status === 'success');
  const d = await bm(win, 'projects.detect', { mirror: c.dir, url });
  const cfg = structuredClone(d.proposals.odoo);
  cfg.id = ID;
  cfg.name = 'Connect as check';
  cfg.naming.db = `bm_${ID}_{slug_}_{build}`;
  cfg.naming.host = `{slug}.${ID}.localhost`;
  cfg.runtime.network = `bm-${ID}`;
  cfg.postgres.protectedContainers = [`bm-${ID}-db`];
  cfg.repo.worktreesDir = `${ROOT}/worktrees`;
  cfg.repo.fetchIntervalMin = 0;
  cfg.runtime.filestore.hostDir = `${ROOT}/filestore`;
  cfg.production.backups.dir = null;
  await bm(win, 'projects.create', { yaml: YAML.stringify(cfg) });
  await waitJobs(win, ID, 900000);
  const main = await waitBranch(win, 'main');
  if (!(await bm(win, 'builds.list', { branchId: main.id, offset: 0, limit: 1 })).total) {
    check('Rebuild', (await waitJob(win, (await bm(win, 'builds.rebuild', { branchId: main.id })).jobId)).status === 'success');
  }
  return main;
}

/** HTTP to Traefik on loopback with the build's Host (Node does not resolve `*.localhost`), redirects not followed. */
function request(url, { method = 'GET', cookie, body } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const headers = { Host: u.host, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) };
    const req = http.request({ host: '127.0.0.1', port: u.port || 80, path: u.pathname + u.search, method, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

/** GET: status, Location and the session_id cookie. */
async function open(url, cookie) {
  const r = await request(url, { cookie });
  const set = (r.headers['set-cookie'] ?? []).find((c) => c.startsWith('session_id='));
  return { status: r.status, location: r.headers.location ?? null, cookie: set?.split(';')[0] ?? null, setCookie: set ?? null };
}

const rpc = async (url, cookie, params) => JSON.parse((await request(url, { method: 'POST', cookie, body: { jsonrpc: '2.0', method: 'call', params } })).data);

/** Who Odoo thinks the cookie belongs to. */
async function whoami(base, cookie) {
  const j = await rpc(`${base}/web/session/get_session_info`, cookie, {});
  return j.result ? { uid: j.result.uid, login: j.result.username } : { error: j.error?.data?.name ?? JSON.stringify(j.error) };
}

const opened = (app) => app.evaluate(() => globalThis.__bmOpened.splice(0));

const others = () => docker('ps', '-a', '--format', '{{.Names}}').split('\n').filter((n) => n && !n.startsWith(`bm-${ID}-`)).sort().join(',');
const othersBefore = others();
const { app, win } = await launch();
try {
  await app.evaluate(({ shell }) => {
    globalThis.__bmOpened = [];
    shell.openExternal = async (u) => void globalThis.__bmOpened.push(u);
  });
  const state = await bm(win, 'system.state');
  if (state.firstRun) await bm(win, 'system.completeFirstRun', {});
  // Left over by an interrupted run of this scenario (dev profile only).
  if ((await bm(win, 'projects.list')).some((p) => p.id === ID)) {
    const j = await waitJob(win, (await bm(win, 'projects.delete', { projectId: ID, confirm: ID })).jobId);
    console.log(`старый проект ${ID} удалён: ${j.status}`);
  }
  const main = await setup(win);
  const b = (await bm(win, 'builds.list', { branchId: main.id, offset: 0, limit: 1 })).items[0];
  check('сборка запущена', b?.status === 'running', b?.status);
  check('Traefik с file-провайдером', docker('inspect', '-f', '{{json .Config.Cmd}}', 'bm-traefik').includes('--providers.file.directory=/dynamic'));

  const users = await bm(win, 'builds.users', { buildId: b.id });
  check('в списке admin, без portal/public', users.items.some((u) => u.login === 'admin') && !users.items.some((u) => u.login === 'public' || u.login === '__system__'), JSON.stringify(users.items));

  // UI: CONNECT ▾ → «Войти как…» → dialog with the users.
  await win.evaluate((p) => (location.hash = p), `#/projects/${ID}/branches/${main.id}/history`);
  await win.getByTestId('connect').first().waitFor({ timeout: 30000 });
  await win.getByLabel('Ещё').first().click();
  await win.getByTestId('connect-as').click();
  await win.getByTestId('connect-as-user').first().waitFor({ timeout: 30000 });
  await shot(win, 'connect-as-dialog');
  check('диалог показывает пользователей', (await win.getByTestId('connect-as-user').count()) === users.items.length);
  await win.getByTestId('connect-as-user').first().click();
  const until = Date.now() + 120000;
  let urls = [];
  while (!urls.length && Date.now() < until) {
    await pause(500);
    urls = await opened(app);
  }
  check('из диалога открыт URL входа', urls.length === 1 && /\/bm\/connect\/[0-9a-f]{32}$/.test(urls[0]), JSON.stringify(urls));
  check('диалог закрылся', (await win.getByTestId('connect-as-user').count()) === 0);

  const r = await open(urls[0]);
  check('ссылка ставит cookie и ведёт в /web', r.status === 302 && r.location === '/web' && !!r.cookie && /HttpOnly/.test(r.setCookie ?? ''), JSON.stringify(r));
  const base = new URL(urls[0]).origin;
  const who = r.cookie ? await whoami(base, r.cookie) : null;
  check('Odoo узнаёт сессию admin', who?.login === 'admin', JSON.stringify(who));
  const web = r.cookie ? await open(`${base}/odoo`, r.cookie) : null;
  check('/odoo открывается без входа', web?.status === 200, JSON.stringify(web));

  // A logged-in admin creates another internal user; connect as them by login.
  const created = await rpc(`${base}/web/dataset/call_kw/res.users/create`, r.cookie, {
    model: 'res.users',
    method: 'create',
    args: [{ name: 'Тест Тестович', login: 'bm_probe_user' }],
    kwargs: {},
  });
  if (Array.isArray(created.result)) created.result = created.result[0];
  check('создан пользователь bm_probe_user', typeof created.result === 'number', JSON.stringify(created.error?.data?.message ?? created.result));
  await bm(win, 'builds.connectAs', { buildId: b.id, login: 'bm_probe_user' });
  const [u2] = await opened(app);
  const r2 = await open(u2);
  const who2 = r2.cookie ? await whoami(base, r2.cookie) : null;
  check('вход по логину bm_probe_user', who2?.login === 'bm_probe_user' && who2.uid === created.result, JSON.stringify(who2));
  check('сессия admin не тронута', (await whoami(base, r.cookie)).login === 'admin');

  const err = await win.evaluate(([id]) => window.bm.call('builds.connectAs', { buildId: id, login: 'nobody_here' }).then(() => null, (e) => String(e?.message ?? e)), [b.id]);
  check('неизвестный логин — понятная ошибка', !!err && err.includes('нет пользователя'), err ?? '');
  const inactive = await win.evaluate(([id]) => window.bm.call('builds.connectAs', { buildId: id, login: '__system__' }).then(() => null, (e) => String(e?.message ?? e)), [b.id]);
  check('архивный пользователь — отказ', !!inactive && inactive.includes('архивирован'), inactive ?? '');

  await pause(65000);
  const gone = await open(urls[0]);
  check('через минуту ссылка входа не работает', gone.status !== 302 || gone.location !== '/web', JSON.stringify(gone));
  check('файлы маршрутов в Traefik убраны', docker('exec', 'bm-traefik', 'ls', '-A', '/dynamic') === '', docker('exec', 'bm-traefik', 'ls', '-A', '/dynamic'));
  const audit = await bm(win, 'audit.list', { projectId: ID, action: 'build.connectAs' }).catch((e) => ({ items: [], e: String(e) }));
  check('вход записан в журнал', JSON.stringify(audit).includes('build.connectAs'), JSON.stringify(audit).slice(0, 300));
} catch (err) {
  check('без исключений', false, err.stack ?? err.message);
  await shot(win, 'connect-as-fail').catch(() => {});
} finally {
  if ((await bm(win, 'projects.list')).some((p) => p.id === ID)) {
    const j = await waitJob(win, (await bm(win, 'projects.delete', { projectId: ID, confirm: ID })).jobId);
    check(`проект ${ID} удалён`, j.status === 'success', j.error ?? '');
  }
  check('контейнеры других проектов на месте', others() === othersBefore);
  await app.close();
  const own = path.join(process.env.LOCALAPPDATA, 'Odoo Branch Manager', 'traefik', 'compose.yml');
  if (fs.existsSync(own)) docker('compose', '-p', 'bm-traefik', '-f', own, 'up', '-d');
}
console.log(`Итого: ${results.filter(Boolean).length} из ${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
