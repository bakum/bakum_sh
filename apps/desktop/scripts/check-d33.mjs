// D33 / D34 in the sandbox, on the real app (BM_PROFILE=dev):
//  1 — wizard (UI): address from the user's folder → access check → the app's own copy → detection;
//  2 — project created from that copy (DEMZ runtime, fresh Development databases);
//  3 — a Development branch builds from "GitHub" (tmp/sandbox/origin.git); the user's clone keeps every branch free;
//  4 — push to origin → fetch → update build on the new commit;
//  5 — code from the user's folder: the container mounts it, uncommitted edits count, a local commit triggers a build;
//  6 — Fork creates the branch in origin and builds it;
//  7 — full project deletion.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch, shot, bm } from './pw.mjs';
import { SANDBOX, ORIGIN_URL, ensureSandbox, waitJob, waitJobs, branch, lastBuild } from './sandbox.mjs';

const ID = 'sbx';
const CLONE = `${SANDBOX}/demz-odoo`;
const PUSHER = `${SANDBOX}/pusher`;
const ORIGIN = `${SANDBOX}/origin.git`;
const BR = 'demz-roman';
const MODULE = 'demz_phone_whatsapp';
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8' }).trim();
const step = (s) => console.log(`\n=== ${s}`);
const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};

async function waitBuild(win, b) {
  const t0 = Date.now();
  await waitJobs(win, ID, 3 * 3600000);
  const x = await lastBuild(win, b.id);
  console.log(`#${x.number} ${x.status} ${x.kind} ${x.dbName} ${x.commitSha?.slice(0, 7)} ${Math.round((Date.now() - t0) / 1000)}s ${x.errorMessage ?? ''}`);
  for (const s of x.steps) console.log('  ', s.name, s.status, s.note ?? '');
  return x;
}

const { app, win } = await launch();
win.setDefaultTimeout(60000);
try {
  const state = await bm(win, 'system.state');
  if (state.firstRun) await bm(win, 'system.completeFirstRun', {});
  if ((await bm(win, 'projects.list')).some((p) => p.id === ID)) {
    console.log('старый прогон: удаляю проект', ID);
    await waitJob(win, (await bm(win, 'projects.delete', { projectId: ID, confirm: ID })).jobId);
  }
  var startBranch = git(CLONE, 'branch', '--show-current');
  var origRoman = git(ORIGIN, 'rev-parse', BR);
  var pusherBranch = git(PUSHER, 'branch', '--show-current');

  step('1. Мастер (UI): адрес из папки → доступ → копия приложения → определение');
  await win.evaluate(() => (location.hash = '#/projects/new'));
  await win.getByText('Адрес из папки на диске').click();
  await win.getByLabel('Папка вашего клона').fill(CLONE);
  await win.getByRole('button', { name: 'Прочитать адрес' }).click();
  await win.getByText('Адрес:').waitFor();
  check('адрес прочитан из папки', await win.getByText(ORIGIN_URL).first().isVisible(), ORIGIN_URL);
  await win.getByRole('button', { name: 'Проверить доступ' }).click();
  await win.getByText('Доступ есть').waitFor();
  await win.getByRole('button', { name: 'Загрузить' }).click();
  await win.getByText('Загружено в').waitFor({ timeout: 600000 });
  await win.getByText('Копия приложения').waitFor({ timeout: 120000 });
  await shot(win, 'd33-wizard');
  const cloneJob = (await bm(win, 'jobs.list', { limit: 20 })).find((j) => j.type === 'clone' && j.params.mirror);
  const wizardMirror = cloneJob?.params.dir;
  check('копия приложения загружена задачей clone', cloneJob?.status === 'success' && fs.existsSync(`${wizardMirror}/HEAD`), wizardMirror);
  check('определение по копии приложения', await win.getByText(wizardMirror).first().isVisible());
  check('в вашем клоне нет worktree приложения', git(CLONE, 'worktree', 'list').split('\n').length === 1);

  step('2. Проект (runtime DEMZ, Development — чистая БД)');
  await ensureSandbox(win, {
    id: ID,
    mirror: wizardMirror,
    // One light module: the whole DEMZ list needs uk_UA activated, which only the prod mirror has.
    stages: { development: { database: 'fresh', install: { list: [MODULE] }, withDemo: false, onNewCommit: 'update', updateModules: 'changed' } },
  });
  await waitJobs(win, ID, 600000);
  const proj = await bm(win, 'projects.get', { projectId: ID });
  const mirror = proj.config.repo.mirrorDir;
  console.log('mirror', mirror, '| url', proj.config.repo.url);
  check('проект новой схемы', !proj.summary.legacy && fs.existsSync(mirror));
  let b = await branch(win, ID, BR);
  check(`ветка ${BR} в Development`, b?.stage === 'development');

  step('3. Сборка с «GitHub», ваш клон свободен');
  await bm(win, 'builds.rebuild', { branchId: b.id });
  await new Promise((r) => setTimeout(r, 8000));
  // The main complaint: the branch the app builds can be checked out in your own clone at the same time.
  let switched = false;
  try {
    git(CLONE, 'checkout', BR);
    switched = git(CLONE, 'branch', '--show-current') === BR;
  } finally {
    git(CLONE, 'checkout', startBranch);
  }
  check('git checkout той же ветки в вашем клоне во время сборки', switched);
  let x = await waitBuild(win, b);
  check('сборка из копии приложения', x.status === 'running' && x.commitSha === git(ORIGIN, 'rev-parse', BR));
  if (x.status !== 'running') throw new Error('нет живой сборки — дальше проверять нечего');
  b = await branch(win, ID, BR);
  const wtList = git(mirror, 'worktree', 'list', '--porcelain');
  check('worktree в копии приложения, detached', wtList.includes(b.worktreePath) && /detached/.test(wtList), b.worktreePath);
  check('в вашем клоне по-прежнему один чекаут', git(CLONE, 'worktree', 'list').split('\n').length === 1);
  await win.evaluate((h) => (location.hash = h), `#/projects/${ID}/branches/${b.id}/editor`);
  await new Promise((r) => setTimeout(r, 2500));
  await shot(win, 'd33-editor-github');

  step('4. Push в origin → fetch → обновление');
  const wanted = MODULE;
  const modDir = git(ORIGIN, 'ls-tree', '-r', '--name-only', BR).split('\n').find((f) => f.endsWith(`/${wanted}/__manifest__.py`)).replace('/__manifest__.py', '');
  console.log('модуль для правок:', wanted, modDir);
  git(PUSHER, 'fetch', 'origin');
  git(PUSHER, 'checkout', '-B', BR, `origin/${BR}`);
  fs.writeFileSync(path.join(PUSHER, modDir, 'd33_push.py'), '# D33 check: pushed change\n');
  git(PUSHER, 'add', '.');
  git(PUSHER, '-c', 'user.name=bm', '-c', 'user.email=bm@local', 'commit', '-m', 'D33 check: push');
  git(PUSHER, 'push', 'origin', BR);
  const pushed = git(PUSHER, 'rev-parse', 'HEAD');
  await bm(win, 'git.fetch', { projectId: ID });
  await new Promise((r) => setTimeout(r, 5000));
  x = await waitBuild(win, b);
  check('обновление на запушенном коммите', x.kind === 'update' && x.commitSha === pushed && x.status === 'running');
  check('обновлён изменённый модуль', (x.steps.find((s) => s.name === 'modules')?.note ?? '').includes(wanted));

  step('5. Код из вашей папки');
  git(CLONE, 'fetch', 'origin');
  git(CLONE, 'checkout', BR);
  git(CLONE, 'reset', '--hard', `origin/${BR}`);
  const eff = await bm(win, 'config.effective', { branchId: b.id });
  await bm(win, 'branches.setOverrides', { branchId: b.id, overrides: { ...eff.branchOverrides, folder: CLONE } });
  b = await branch(win, ID, BR);
  check('ветка берёт код из папки', b.folder === CLONE && b.codeDir === CLONE);
  check('бейдж «Конфигурация изменилась»', b.badges.some((z) => z.kind === 'config-changed'));
  await waitJob(win, (await bm(win, 'builds.action', { buildId: b.liveBuild.id, action: 'apply-config' })).jobId);
  const cname = docker('ps', '--filter', `label=bm.project=${ID}`, '--format', '{{.Names}}').split('\n')[0];
  const mounts = JSON.parse(docker('inspect', '-f', '{{json .Mounts}}', cname));
  const repoMount = proj.config.runtime.repoMount;
  const m = mounts.find((z) => z.Destination === repoMount);
  check('контейнер монтирует вашу папку', !!m && m.Source.toLowerCase().replace(/\\/g, '/').endsWith('tmp/sandbox/demz-odoo'), m?.Source);
  fs.writeFileSync(path.join(CLONE, modDir, 'd33_local.py'), '# D33 check: uncommitted edit\n');
  const ch = await bm(win, 'builds.changedModules', { branchId: b.id });
  check('незакоммиченная правка видна как изменённый модуль', ch.modules.some((z) => z.name === wanted), JSON.stringify(ch.modules.map((z) => `${z.name}:${z.action}`)));
  await win.evaluate((h) => (location.hash = h), `#/projects/${ID}/branches/${b.id}/editor`);
  await new Promise((r) => setTimeout(r, 2500));
  await shot(win, 'd33-editor-folder');
  git(CLONE, 'add', '.');
  git(CLONE, '-c', 'user.name=bm', '-c', 'user.email=bm@local', 'commit', '-m', 'D33 check: local commit');
  const local = git(CLONE, 'rev-parse', 'HEAD');
  await new Promise((r) => setTimeout(r, 8000));
  x = await waitBuild(win, b);
  check('локальный коммит в папке запустил обновление', x.commitSha === local && x.status === 'running');
  check('в вашей папке нет изменений от приложения', git(CLONE, 'status', '--porcelain') === '', git(CLONE, 'status', '--porcelain'));

  step('6. Fork → ветка на «GitHub»');
  const fork = await bm(win, 'branches.fork', { branchId: b.id, name: 'd33' });
  check('ветка создана в origin', git(ORIGIN, 'branch', '--list', fork.branch.name) !== '', fork.branch.name);
  check('Fork начал с запушенного коммита, а не с локального', git(ORIGIN, 'rev-parse', fork.branch.name) === pushed);
  const fb = await waitBuild(win, fork.branch);
  check('сборка новой ветки', fb.status === 'running');

  step('7. Полное удаление проекта');
  const pv = await bm(win, 'projects.deletePreview', { projectId: ID });
  console.log(JSON.stringify(pv, null, 1));
  const dj = await waitJob(win, (await bm(win, 'projects.delete', { projectId: ID, confirm: ID })).jobId);
  check('задача удаления', dj.status === 'success', dj.error ?? '');
  check('копия приложения удалена', !fs.existsSync(mirror));
  check('папки проекта удалены', pv.folders.every((f) => !fs.existsSync(f)), pv.folders.join(', '));
  check('контейнеров нет', docker('ps', '-a', '--filter', `label=bm.project=${ID}`, '-q') === '');
  check('проекта нет в списке', !(await bm(win, 'projects.list')).some((p) => p.id === ID));
  check('ваша папка на месте', fs.existsSync(path.join(CLONE, modDir, 'd33_local.py')));
} finally {
  // Sandbox back to its state: the user's clone, origin branches of this check.
  try {
    git(CLONE, 'checkout', '-f', startBranch ?? '19.0-demz-perevertum');
    git(CLONE, 'clean', '-fdq', '--', '.');
    if (origRoman) {
      git(ORIGIN, 'update-ref', `refs/heads/${BR}`, origRoman);
      git(CLONE, 'branch', '-f', BR, origRoman);
      git(PUSHER, 'checkout', '-f', pusherBranch);
      git(PUSHER, 'branch', '-f', BR, origRoman);
    }
    for (const r of ['19.0-demz-d33']) if (git(ORIGIN, 'branch', '--list', r)) git(ORIGIN, 'branch', '-D', r);
    git(CLONE, 'fetch', '--prune', 'origin');
  } catch (e) {
    console.log('восстановление песочницы:', e.message);
  }
  await app.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\nИтого: ${results.length - failed.length} из ${results.length} проверок прошли`);
process.exit(failed.length ? 1 : 0);
