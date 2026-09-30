// Fork failures (D57) on a tiny «Odoo in Docker» project: the bare origin has a pre-receive hook that answers like
// GitHub — «Permission to … denied to someone» for names with «denied», «GH013: Repository rule violations» for names
// with «rule». The Fork dialog must stay open and say what happened and what to do; a plain name still works.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { launch, bm, shot } from './pw.mjs';
import { SANDBOX, waitJob, waitJobs, branch } from './sandbox.mjs';

const ID = 'bmfork';
const VERSION = '19.0';
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=bm', '-c', 'user.email=bm@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
const pause = (ms = 2000) => new Promise((r) => setTimeout(r, ms));

const ROOT = `${SANDBOX}/${ID}`;
const WORK = `${ROOT}/work`;
const ORIGIN = `${ROOT}/origin.git`;

const HOOK = `#!/bin/sh
while read old new ref; do
  case "$ref" in
    *denied*) echo "Permission to acme/shop.git denied to someone." >&2; exit 1 ;;
    *rule*) echo "error: GH013: Repository rule violations found for $ref." >&2; exit 1 ;;
  esac
done
exit 0
`;

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
  fs.writeFileSync(`${ORIGIN}/hooks/pre-receive`, HOOK, { mode: 0o755 });
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
  const url = makeOrigin();
  const c = await bm(win, 'repo.clone', { url, mirror: true, shallow: false });
  const cj = await waitJob(win, c.jobId);
  check('копия репозитория', cj.status === 'success', cj.error ?? '');
  const d = await bm(win, 'projects.detect', { mirror: c.dir, url });
  const cfg = structuredClone(d.proposals.odoo);
  cfg.id = ID;
  cfg.name = 'Fork errors check';
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

  // Through the API: the error carries the problem and the refused account.
  const err = await win.evaluate(
    // settle(): a rejected window.bm.call loses code and details on contextBridge.
    ([id]) => window.bm.settle('branches.fork', { branchId: id, name: 'denied-api' }).then((r) => (r.ok ? null : r.error)),
    [main.id],
  );
  check('API: GIT_PUSH, problem denied, account someone', err?.code === 'GIT_PUSH' && err.details?.problem === 'denied' && err.details?.account === 'someone', JSON.stringify(err));
  check('API: https=false для file://', err?.details?.https === false);

  // Through the dialog.
  await win.evaluate((p) => (location.hash = p), `#/projects/${ID}/branches/${main.id}`);
  await win.getByRole('button', { name: 'Fork' }).click();
  const dialog = win.getByRole('dialog');
  await dialog.waitFor();
  check('до попытки сказано про учётную запись и роль Write', /роль Write/.test(await (async () => {
    await dialog.getByLabel('Имя новой ветки').fill('denied-ui');
    await dialog.getByText('будет создана в репозитории').waitFor();
    return dialog.innerText();
  })()));
  await dialog.getByRole('button', { name: 'Создать ветку' }).click();
  const fe = dialog.getByTestId('fork-error');
  await fe.waitFor({ timeout: 60000 });
  const deniedText = await fe.innerText();
  check('ошибка в диалоге, диалог открыт', await dialog.isVisible());
  check('названа учётная запись someone', deniedText.includes('«someone»'), deniedText.split('\n')[1]);
  check('подсказка: попросить роль Write', /роль Write/.test(deniedText) && /Collaborators/.test(deniedText));
  check('для file:// нет «Войти и повторить»', (await dialog.getByRole('button', { name: 'Войти и повторить' }).count()) === 0);
  await shot(win, 'fork-error-denied');

  await dialog.getByLabel('Имя новой ветки').fill('rule-ui');
  check('смена имени убирает ошибку', (await fe.count()) === 0);
  await dialog.getByText('rule-ui').first().waitFor();
  await dialog.getByRole('button', { name: 'Создать ветку' }).click();
  await fe.waitFor({ timeout: 60000 });
  const ruleText = await fe.innerText();
  check('правила репозитория: другое имя или администратор', /Правила репозитория/.test(ruleText) && /другое имя/.test(ruleText), ruleText.replace(/\n/g, ' | '));
  await shot(win, 'fork-error-rules');

  await dialog.getByLabel('Имя новой ветки').fill('plain');
  await dialog.getByText('будет создана в репозитории').waitFor();
  await dialog.getByRole('button', { name: 'Создать ветку' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 120000 });
  check('обычное имя: ветка создана, диалог закрыт', !!(await waitBranch(win, 'plain')));
  check('на origin нет отклонённых веток', !/denied|rule/.test(git(ORIGIN, 'branch', '--list')), git(ORIGIN, 'branch', '--list').replace(/\n/g, ' '));
  await waitJobs(win, ID, 900000);
}

const { app, win } = await launch();
try {
  const state = await bm(win, 'system.state');
  if (state.firstRun) await bm(win, 'system.completeFirstRun', {});
  await run(win);
} catch (err) {
  check('без исключений', false, err.stack ?? err.message);
  await shot(win, 'fork-error-fail').catch(() => {});
} finally {
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
