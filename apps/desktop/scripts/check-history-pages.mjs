// History of a branch pages by 5 builds (paginator and «Сборок: N» above the timeline, a second paginator below) on a
// tiny «Odoo in Docker» project whose Production branch is rebuilt until it has 7 builds. The repository has no
// .gitignore, so Odoo's __pycache__ must not block the rebuilds; deleting the project must not reach containers of
// other projects or of the other profile that carry the same bm.build id.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { launch, bm, shot } from './pw.mjs';
import { SANDBOX, waitJob, waitJobs, branch } from './sandbox.mjs';

const ID = 'bmhist';
const VERSION = '19.0';
const BUILDS = 7;
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=bm', '-c', 'user.email=bm@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
const pause = (ms = 2000) => new Promise((r) => setTimeout(r, ms));

const ROOT = `${SANDBOX}/${ID}`;
const WORK = `${ROOT}/work`;
const ORIGIN = `${ROOT}/origin.git`;

function makeOrigin() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(`${WORK}/addons/bm_probe`, { recursive: true });
  fs.writeFileSync(
    `${WORK}/addons/bm_probe/__manifest__.py`,
    `{'name': 'bm_probe', 'version': '${VERSION}.1.0.0', 'depends': ['base'], 'license': 'LGPL-3', 'installable': True}\n`,
  );
  fs.writeFileSync(`${WORK}/addons/bm_probe/__init__.py`, '');
  fs.writeFileSync(`${WORK}/modules_to_install.txt`, 'bm_probe\n');
  git(ROOT, 'init', '-q', '-b', 'main', 'work');
  git(WORK, 'add', '-A');
  git(WORK, 'commit', '-q', '-m', 'probe');
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

async function run(win) {
  const rebuilds = [];
  const url = makeOrigin();
  const c = await bm(win, 'repo.clone', { url, mirror: true, shallow: false });
  check('копия репозитория', (await waitJob(win, c.jobId)).status === 'success');
  const d = await bm(win, 'projects.detect', { mirror: c.dir, url });
  const cfg = structuredClone(d.proposals.odoo);
  cfg.id = ID;
  cfg.name = 'History pages check';
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

  for (let i = 0; ; i++) {
    const { total } = await bm(win, 'builds.list', { branchId: main.id, offset: 0, limit: 1 });
    if (total >= BUILDS) break;
    if (i > BUILDS + 2) throw new Error(`сборок только ${total}`);
    const j = await waitJob(win, (await bm(win, 'builds.rebuild', { branchId: main.id })).jobId);
    rebuilds.push(j.status);
  }
  check('все Rebuild успешны (__pycache__ не мешает)', rebuilds.every((x) => x === 'success'), rebuilds.join(', '));
  const { total } = await bm(win, 'builds.list', { branchId: main.id, offset: 0, limit: 1 });
  check(`у ветки ${BUILDS}+ сборок`, total >= BUILDS, String(total));

  await win.evaluate((p) => (location.hash = p), `#/projects/${ID}/branches/${main.id}/history`);
  const header = win.getByTestId('history-header');
  await header.waitFor({ timeout: 30000 });
  const cards = win.locator('.mantine-Timeline-item');
  await cards.first().waitFor();
  check('«Сборок: N» над лентой', (await header.innerText()).includes(`Сборок: ${total}`), await header.innerText());
  check('на первой странице 5 сборок', (await cards.count()) === 5, String(await cards.count()));
  const pagers = win.locator('.mantine-Pagination-root');
  check('пагинатор сверху и снизу', (await pagers.count()) === 2, String(await pagers.count()));
  const top = await header.boundingBox();
  const firstCard = await cards.first().boundingBox();
  check('верхний пагинатор выше первой сборки', !!top && !!firstCard && top.y < firstCard.y);
  await shot(win, 'history-page1');

  await header.locator('.mantine-Pagination-control', { hasText: '2' }).click();
  await pause(1500);
  check(`на второй странице ${total - 5}`, (await cards.count()) === total - 5, String(await cards.count()));
  const firstNumber = await cards.first().innerText();
  check('вторая страница — старые сборки (#2 или #1)', /сборка #[12]\b/.test(firstNumber), firstNumber.split('\n').slice(0, 2).join(' '));
  await shot(win, 'history-page2');
}

const others = () => docker('ps', '-a', '--format', '{{.Names}}').split('\n').filter((n) => n && !n.startsWith(`bm-${ID}-`)).sort().join(',');
const othersBefore = others();
const { app, win } = await launch();
try {
  const state = await bm(win, 'system.state');
  if (state.firstRun) await bm(win, 'system.completeFirstRun', {});
  // Left over by an interrupted run of this scenario (dev profile only).
  if ((await bm(win, 'projects.list')).some((p) => p.id === ID)) {
    const j = await waitJob(win, (await bm(win, 'projects.delete', { projectId: ID, confirm: ID })).jobId);
    console.log(`старый проект ${ID} удалён: ${j.status}`);
  }
  await run(win);
} catch (err) {
  check('без исключений', false, err.stack ?? err.message);
  await shot(win, 'history-fail').catch(() => {});
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
