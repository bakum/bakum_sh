// The «+» dialog of a stage explains itself: it adds a branch that already exists on the remote, says what happens
// (build right away or not, which database) and, with nothing left to add, says so instead of an empty list; with
// autoAddBranches: all it says that new remote branches are added by fetch.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launch, shot, bm } from './pw.mjs';
import { SANDBOX, ensureSandbox, waitJob, waitJobs, branch } from './sandbox.mjs';

const ID = 'bmadd';
const NEW = 'bm-add-check';
const ORIGIN = `${SANDBOX}/origin.git`;
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const git = (...args) => execFileSync('git', ['-C', ORIGIN, ...args], { encoding: 'utf8' }).trim();
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const pause = (ms = 1500) => new Promise((r) => setTimeout(r, ms));

async function fetchAndWait(win) {
  const r = await bm(win, 'git.fetch', { projectId: ID });
  if (r?.jobId) await waitJob(win, r.jobId);
  await waitJobs(win, ID, 600000);
}

async function openPlus(win) {
  await win.evaluate((h) => (location.hash = h), `#/projects/${ID}/branches`);
  await pause();
  await win.getByRole('button', { name: 'Добавить в DEVELOPMENT' }).click();
  await pause();
  return win.getByRole('dialog');
}

const { app, win } = await launch();
try {
  await ensureSandbox(win, { id: ID });
  await waitJobs(win, ID, 600000);

  // Nothing to add: every remote branch is in the app.
  let l = await bm(win, 'branches.list', { projectId: ID });
  console.log('не добавлены:', l.unassigned.map((u) => u.name).join(', ') || '(нет)');
  if (!l.unassigned.length) {
    const dlg = await openPlus(win);
    check('пустой список: вместо поля — «Все ветки репозитория уже добавлены»', await dlg.getByText('Все ветки репозитория уже добавлены').isVisible());
    check('пустой список: кнопка «Закрыть»', await dlg.getByRole('button', { name: 'Закрыть' }).isVisible());
    check('DEMZ (autoAddBranches: all): объяснено, что новые ветки добавляются сами', await dlg.getByText('приложение добавляет само при fetch').isVisible());
    await shot(win, 'add-dialog-empty');
    await dlg.getByRole('button', { name: 'Закрыть' }).click();
  }

  // A branch created on the "GitHub" of the sandbox is added by fetch (autoAddBranches: all), without a build
  // (buildOnAdd: false); deleted from the app, it shows up under «+».
  git('branch', '-f', NEW, 'HEAD');
  await fetchAndWait(win);
  const added = await branch(win, ID, NEW);
  check('новая ветка добавлена fetch сама', !!added && added.stage === 'development');
  check('сборка при этом не запущена', !added?.liveBuild && !(await bm(win, 'jobs.list', { projectId: ID, active: true })).length);
  const del = await bm(win, 'branches.delete', { branchId: added.id, confirmSlug: added.slug, deleteRemote: false, forceDirty: false });
  await waitJob(win, del.jobId);
  l = await bm(win, 'branches.list', { projectId: ID });
  check('удалённая из приложения — в «Не добавлены»', l.unassigned.some((u) => u.name === NEW), l.unassigned.map((u) => u.name).join(', '));

  const pv = await bm(win, 'branches.addPreview', { projectId: ID, name: NEW, stage: 'development' });
  console.log('addPreview:', JSON.stringify(pv));
  check('addPreview: DEMZ Development — без сборки при добавлении, база — копия прода', pv.build === false && pv.copyOf === '19.0' && !pv.fresh, JSON.stringify(pv));

  const dlg = await openPlus(win);
  check('диалог объясняет, что ветка берётся с GitHub', await dlg.getByText('уже есть в репозитории на GitHub').isVisible());
  await dlg.getByRole('textbox', { name: /ещё не добавленная/ }).click();
  await win.getByRole('option', { name: NEW }).click();
  await pause();
  const text = await dlg.innerText();
  check('после выбора: что будет со сборкой и базой', text.includes('Сборка сама не начнётся') && text.includes(`код из ${NEW}`) && text.includes('копия базы 19.0'), text);
  await shot(win, 'add-dialog-selected');
  await dlg.getByRole('button', { name: 'Отмена' }).click();
  l = await bm(win, 'branches.list', { projectId: ID });
  check('Отмена ничего не добавила', l.unassigned.some((u) => u.name === NEW));
} catch (err) {
  check('без исключений', false, err.stack ?? err.message);
} finally {
  try {
    git('branch', '-D', NEW);
  } catch {
    /* not created */
  }
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
