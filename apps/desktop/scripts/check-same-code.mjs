// D76: a folder branch (onNewCommit: update, tests: changed). Edits are updated (-u) and tested by hand before the
// commit; the commit then only marks the live build — no build, the container keeps running. Updated by hand but not
// tested: the update build skips the -u and runs the tests. Tests failed by hand: the update build does neither -u nor
// tests again, carries the red result over and fails as before (the live build stays).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import YAML from 'yaml';
import { launch, bm, shot } from './pw.mjs';
import { SANDBOX, waitJob, waitJobs, branch, lastBuild } from './sandbox.mjs';

const ID = 'bmsame';
const VERSION = '19.0';
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).trim();
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=bm', '-c', 'user.email=bm@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
const pause = (ms = 2000) => new Promise((r) => setTimeout(r, ms));

const ROOT = `${SANDBOX}/${ID}`;
const WORK = `${ROOT}/work`;
const ORIGIN = `${ROOT}/origin.git`;
const CLONE = `${ROOT}/clone`;
const MOD = 'addons/bm_probe';

const testFile = (bad) =>
  [
    'from odoo.tests import TransactionCase, tagged',
    '',
    '',
    "@tagged('post_install', '-at_install')",
    'class TestProbe(TransactionCase):',
    '    def test_ok(self):',
    '        self.assertTrue(True)',
    ...(bad ? ['', '    def test_bad(self):', '        self.assertEqual(1, 2)'] : []),
    '',
  ].join('\n');

function makeOrigin() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(`${WORK}/${MOD}/tests`, { recursive: true });
  fs.writeFileSync(
    `${WORK}/${MOD}/__manifest__.py`,
    `{'name': 'bm_probe', 'version': '${VERSION}.1.0.0', 'depends': ['base'], 'license': 'LGPL-3', 'installable': True}\n`,
  );
  fs.writeFileSync(`${WORK}/${MOD}/__init__.py`, '');
  fs.writeFileSync(`${WORK}/${MOD}/tests/__init__.py`, 'from . import test_probe\n');
  fs.writeFileSync(`${WORK}/${MOD}/tests/test_probe.py`, testFile(false));
  fs.writeFileSync(`${WORK}/modules_to_install.txt`, 'bm_probe\n');
  fs.writeFileSync(`${WORK}/.gitignore`, '__pycache__/\n');
  git(ROOT, 'init', '-q', '-b', 'main', 'work');
  git(WORK, 'add', '-A');
  git(WORK, 'commit', '-q', '-m', 'probe');
  git(WORK, 'checkout', '-q', '-b', 'feat');
  git(ROOT, 'clone', '-q', '--bare', 'work', 'origin.git');
  git(ROOT, 'clone', '-q', '-b', 'feat', 'origin.git', 'clone');
  return `file:///${ORIGIN}`;
}

async function waitFor(fn, what, timeoutMs = 90000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`не дождались: ${what}`);
    await pause(1000);
  }
}

/** Id and start time of the build's Odoo container (one-off runs excluded): a restart changes StartedAt. */
const containerOf = (build) => {
  const id = docker('ps', '-a', '--filter', `label=bm.build=${build.id}`, '--filter', 'label=com.docker.compose.oneoff=False', '--format', '{{.ID}}');
  return id ? `${id} ${docker('inspect', '-f', '{{.State.Status}} {{.State.StartedAt}}', id)}` : '';
};
const buildLog = (b) => (b.logPath && fs.existsSync(b.logPath) ? fs.readFileSync(b.logPath, 'utf8') : '');
const step = (b, name) => b.steps.find((s) => s.name === name);
// Build log lines in any interface language (the dev profile may run in Ukrainian or English).
const NOT_REPEATED = /-u не повторяется|-u не повторюється|-u is not repeated/;
const NOT_REPEATED_LINE = /^.*(-u не повторяется|-u не повторюється|-u is not repeated).*$/m;
const CARRIED = /итог перенесён|результат перенесено|result is carried over/;
const commit = (msg) => {
  git(CLONE, 'add', '-A');
  git(CLONE, 'commit', '-q', '-m', msg);
  return git(CLONE, 'rev-parse', 'HEAD');
};

async function run(win) {
  const url = makeOrigin();
  const c = await bm(win, 'repo.clone', { url, mirror: true, shallow: false });
  check('копия репозитория', (await waitJob(win, c.jobId)).status === 'success');
  const d = await bm(win, 'projects.detect', { mirror: c.dir, url });
  const cfg = structuredClone(d.proposals.odoo);
  cfg.id = ID;
  cfg.name = 'Same code check';
  cfg.naming.db = `bm_${ID}_{slug_}_{build}`;
  cfg.naming.host = `{slug}.${ID}.localhost`;
  cfg.runtime.network = `bm-${ID}`;
  cfg.postgres.protectedContainers = [`bm-${ID}-db`];
  cfg.repo.worktreesDir = `${ROOT}/worktrees`;
  cfg.repo.localFolder = CLONE;
  cfg.repo.fetchIntervalMin = 0;
  cfg.runtime.filestore.hostDir = `${ROOT}/filestore`;
  cfg.production.backups.dir = null;
  cfg.stages.development = {
    ...cfg.stages.development,
    database: 'fresh',
    install: 'my',
    withDemo: false,
    onNewCommit: 'update',
    idleStopHours: 0,
    tests: { mode: 'changed', failBuild: true },
  };
  await bm(win, 'projects.create', { yaml: YAML.stringify(cfg) });
  await waitJobs(win, ID, 900000);

  // 1. feat from the folder: build #1 (fresh database, bm_probe installed).
  let feat = (await branch(win, ID, 'feat')) ?? (await bm(win, 'branches.add', { projectId: ID, name: 'feat', stage: 'development', build: false }));
  const eff = await bm(win, 'config.effective', { branchId: feat.id });
  await bm(win, 'branches.setOverrides', { branchId: feat.id, overrides: { ...eff.branchOverrides, folder: CLONE } });
  const j1 = await waitJob(win, (await bm(win, 'builds.rebuild', { branchId: feat.id })).jobId, 1800000);
  let live = await lastBuild(win, feat.id);
  check('сборка #1 из папки', j1.status === 'success' && live.status === 'running', j1.error ?? '');
  const total = async () => (await bm(win, 'builds.list', { branchId: feat.id, limit: 1 })).total;

  // 2. Edit → -u and tests by hand → commit: the live build is marked with the commit, nothing is rebuilt.
  fs.writeFileSync(`${CLONE}/${MOD}/models.py`, '# edit 1\n');
  const ju = await waitJob(win, (await bm(win, 'builds.modulesAction', { buildId: live.id, install: [], update: ['bm_probe'] })).jobId);
  const jt = await waitJob(win, (await bm(win, 'builds.testsAction', { buildId: live.id, modules: ['bm_probe'] })).jobId);
  check('-u и тесты руками', ju.status === 'success' && jt.status === 'success', `${ju.error ?? ''} ${jt.error ?? ''}`);
  const container0 = containerOf(live);
  const builds0 = await total();
  const s1 = commit('edit 1');
  live = await waitFor(async () => {
    const b = await lastBuild(win, feat.id);
    return b.commitSha === s1 ? b : null;
  }, 'сборка #1 отмечена коммитом');
  await pause(5000);
  check('новой сборки нет', (await total()) === builds0 && live.number === 1);
  check('контейнер не перезапускался', containerOf(live) === container0, `${container0} → ${containerOf(live)}`);
  check('итог тестов на месте', live.tests?.passed >= 1 && !live.tests?.failed, JSON.stringify(live.tests));
  check('строка в build.log', /отмечена этим коммитом|позначено цим комітом|marked with this commit/.test(buildLog(live)));
  const audit = await bm(win, 'audit.list', { projectId: ID, action: 'build.sameCode', limit: 5 });
  check('запись в аудите build.sameCode', audit.items.some((a) => a.target === 'feat#1'), JSON.stringify(audit.items).slice(0, 200));
  feat = await bm(win, 'branches.get', { branchId: feat.id });
  check('нет бейджа «непостроенные коммиты»', !feat.badges.some((x) => x.kind === 'unbuilt-commits'), feat.badges.map((x) => x.kind).join(','));
  await win.evaluate((p) => (location.hash = p), `#/projects/${ID}/branches/${feat.id}/history`);
  await pause(2000);
  await shot(win, 'same-code-marked');

  // 3. Edit → -u by hand, no tests → commit: build #2 skips the -u, runs the tests.
  fs.writeFileSync(`${CLONE}/${MOD}/models.py`, '# edit 2\n');
  const ju2 = await waitJob(win, (await bm(win, 'builds.modulesAction', { buildId: live.id, install: [], update: ['bm_probe'] })).jobId);
  check('-u руками без тестов', ju2.status === 'success', ju2.error ?? '');
  const s2 = commit('edit 2');
  await waitFor(async () => (await total()) > builds0, 'сборка #2 по коммиту');
  await waitJobs(win, ID, 1800000);
  const b2 = await lastBuild(win, feat.id);
  const log2 = buildLog(b2);
  check('сборка #2 на коммите', b2.number === 2 && b2.status === 'running' && b2.commitSha === s2, `${b2.status} ${b2.errorMessage ?? ''}`);
  check('#2: -u не повторён', NOT_REPEATED.test(log2) && /bm_probe/.test(log2.match(NOT_REPEATED_LINE)?.[0] ?? '') && /-u \/ -i/.test(step(b2, 'modules')?.note ?? ''), step(b2, 'modules')?.note);
  check('#2: тесты запущены', /--test-enable/.test(log2) && step(b2, 'tests')?.status === 'success', step(b2, 'tests')?.note);

  // 4. A failing test → -u and tests by hand (red) → commit: build #3 neither updates nor tests again, carries the red
  // result over and fails; #2 stays live.
  fs.writeFileSync(`${CLONE}/${MOD}/tests/test_probe.py`, testFile(true));
  await waitJob(win, (await bm(win, 'builds.modulesAction', { buildId: b2.id, install: [], update: ['bm_probe'] })).jobId);
  const jt3 = await waitJob(win, (await bm(win, 'builds.testsAction', { buildId: b2.id, modules: ['bm_probe'] })).jobId);
  check('тесты руками упали', jt3.status === 'failed', jt3.error?.split('\n')[0]);
  const builds2 = await total();
  commit('red test');
  await waitFor(async () => (await total()) > builds2, 'сборка #3 по коммиту');
  await waitJobs(win, ID, 1800000);
  const b3 = await lastBuild(win, feat.id);
  const log3 = buildLog(b3);
  check('#3 упала на тестах', b3.status === 'failed' && step(b3, 'tests')?.status === 'failed', `${b3.status} ${b3.errorMessage?.split('\n')[0] ?? ''}`);
  check('#3: -u не повторён, итог перенесён без запуска', NOT_REPEATED.test(log3) && CARRIED.test(log3) && !/--test-enable/.test(log3));
  live = await bm(win, 'builds.get', { buildId: b2.id });
  check('#2 осталась живой и работает', live.status === 'running');
}

const others = () => docker('ps', '-a', '--format', '{{.Names}}').split('\n').filter((n) => n && !n.startsWith(`bm-${ID}-`)).sort().join(',');
const othersBefore = others();
const { app, win } = await launch();
win.setDefaultTimeout(60000);
try {
  const state = await bm(win, 'system.state');
  if (state.firstRun) await bm(win, 'system.completeFirstRun', {});
  if ((await bm(win, 'projects.list')).some((p) => p.id === ID)) {
    const j = await waitJob(win, (await bm(win, 'projects.delete', { projectId: ID, confirm: ID })).jobId);
    console.log(`старый проект ${ID} удалён: ${j.status}`);
  }
  await run(win);
} catch (err) {
  check('без исключений', false, err.stack ?? err.message);
  await shot(win, 'same-code-fail').catch(() => {});
} finally {
  if ((await bm(win, 'projects.list')).some((p) => p.id === ID)) {
    const j = await waitJob(win, (await bm(win, 'projects.delete', { projectId: ID, confirm: ID })).jobId);
    check(`проект ${ID} удалён`, j.status === 'success', j.error ?? '');
  }
  check('контейнеры других проектов на месте', others() === othersBefore);
  await app.close();
  const own = `${process.env.LOCALAPPDATA}/Odoo Branch Manager/traefik/compose.yml`;
  if (fs.existsSync(own)) docker('compose', '-p', 'bm-traefik', '-f', own, 'up', '-d');
}
console.log(`Итого: ${results.filter(Boolean).length} из ${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
