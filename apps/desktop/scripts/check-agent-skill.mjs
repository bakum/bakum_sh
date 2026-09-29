// Assistant skill (D52) on a tiny «Odoo in Docker» project (own Postgres, odoo:19.0): the app writes
// .claude/skills/branch-manager-<id>/SKILL.md into a chosen folder, tracks hand edits and outdated text, the build
// containers carry the bm.* labels the skill relies on, and the -u / test commands of the skill run as written — in
// Git Bash and in PowerShell — against a Development build.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { launch, bm, shot } from './pw.mjs';
import { SANDBOX, waitJob, waitJobs, branch, lastBuild } from './sandbox.mjs';

const ID = 'bmskill';
const VERSION = '19.0';
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=bm', '-c', 'user.email=bm@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
const pause = (ms = 2000) => new Promise((r) => setTimeout(r, ms));
const sql = (db, q) => docker('exec', `bm-${ID}-db`, 'psql', '-U', 'odoo', '-d', db, '-Atc', q);
const label = (c, k) => docker('inspect', '-f', `{{index .Config.Labels "${k}"}}`, c);
const BASH = 'C:/Program Files/Git/bin/bash.exe';

const ROOT = `${SANDBOX}/${ID}`;
const WORK = `${ROOT}/work`;

function writeModule(name, extra = '') {
  fs.mkdirSync(`${WORK}/addons/${name}/tests`, { recursive: true });
  fs.writeFileSync(
    `${WORK}/addons/${name}/__manifest__.py`,
    `{'name': '${name}', 'version': '${VERSION}.1.0.0', 'depends': ['base'], 'license': 'LGPL-3', 'installable': True}\n`,
  );
  fs.writeFileSync(`${WORK}/addons/${name}/__init__.py`, '');
  fs.writeFileSync(`${WORK}/addons/${name}/tests/__init__.py`, 'from . import test_probe\n');
  fs.writeFileSync(
    `${WORK}/addons/${name}/tests/test_probe.py`,
    `from odoo.tests import TransactionCase, tagged\n\n\n@tagged('post_install', '-at_install')\nclass TestProbe(TransactionCase):\n    def test_probe(self):\n        self.assertTrue(self.env['res.users'].search_count([]))${extra}\n`,
  );
}

/** Bare repository: main and feature with addons/bm_probe (a module with one test). */
function makeOrigin() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  writeModule('bm_probe');
  fs.writeFileSync(`${WORK}/modules_to_install.txt`, 'bm_probe\n');
  fs.writeFileSync(`${WORK}/.gitignore`, '__pycache__/\n*.pyc\n');
  git(ROOT, 'init', '-q', '-b', 'main', 'work');
  git(WORK, 'add', '-A');
  git(WORK, 'commit', '-q', '-m', 'probe');
  git(WORK, 'branch', 'feature');
  git(ROOT, 'clone', '-q', '--bare', 'work', 'origin.git');
  return `file:///${ROOT}/origin.git`;
}

async function waitBranches(win, names, timeoutMs = 120000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const found = await Promise.all(names.map((n) => branch(win, ID, n)));
    if (found.every(Boolean)) return found;
    if (Date.now() > until) throw new Error(`ветки ${names.join(', ')} не появились`);
    await pause();
  }
}

async function rebuild(win, br) {
  const j = await waitJob(win, (await bm(win, 'builds.rebuild', { branchId: br.id })).jobId);
  return { job: j, build: await lastBuild(win, br.id) };
}

/** Code blocks of one section of the skill (`## <title>` up to the next `## `). */
function blocks(text, title, lang) {
  const sec = text.split(/\n(?=## )/).find((s) => s.startsWith(`## ${title}`)) ?? '';
  return [...sec.matchAll(new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g'))].map((m) => m[1]);
}

const fill = (s, br) => s.replaceAll('<ветка>', br).replaceAll('<модуль>', 'bm_probe');

async function run(win) {
  const url = makeOrigin();
  const c = await bm(win, 'repo.clone', { url, mirror: true, shallow: false });
  const cj = await waitJob(win, c.jobId);
  check('копия репозитория', cj.status === 'success', cj.error ?? '');
  const d = await bm(win, 'projects.detect', { mirror: c.dir, url });
  const cfg = structuredClone(d.proposals.odoo);
  cfg.id = ID;
  cfg.name = 'Skill check';
  cfg.naming.db = `bm_${ID}_{slug_}_{build}`;
  cfg.naming.host = `{slug}.${ID}.localhost`;
  cfg.runtime.network = `bm-${ID}`;
  cfg.postgres.protectedContainers = [`bm-${ID}-db`];
  cfg.repo.worktreesDir = `${ROOT}/worktrees`;
  cfg.repo.localFolder = WORK;
  cfg.runtime.filestore.hostDir = `${ROOT}/filestore`;
  cfg.production.backups.dir = null;
  await bm(win, 'projects.create', { yaml: YAML.stringify(cfg) });
  await waitJobs(win, ID, 900000);
  const [prodBr, devBr] = await waitBranches(win, ['main', 'feature']);

  // 1. Status and install into the user's clone (a git work tree).
  const s0 = await bm(win, 'agents.skillStatus', { projectId: ID });
  check(
    'до установки: none, предложены корень стека и клон пользователя',
    s0.state === 'none' && s0.dir === ROOT && s0.suggestedDirs.join('|') === `${ROOT}|${WORK}`,
    JSON.stringify({ ...s0, content: undefined }),
  );
  check('в тексте нет пароля Postgres', !s0.content.includes((await bm(win, 'projects.get', { projectId: ID })).config.postgres.password || '\u0000'));
  const inst = await bm(win, 'agents.installSkill', { projectId: ID, dir: WORK });
  const file = `${WORK}/.claude/skills/branch-manager-${ID}/SKILL.md`;
  check('SKILL.md записан', inst.path === file && fs.existsSync(file), inst.path);
  check('папка в git — предупреждение', inst.inGit === true);
  const yaml = (await bm(win, 'projects.get', { projectId: ID })).yaml;
  check('agents.skillsDir сохранён в YAML', YAML.parse(yaml).agents?.skillsDir === WORK);
  check('после установки: current', (await bm(win, 'agents.skillStatus', { projectId: ID })).state === 'current');

  // 2. Hand edit → modified; overwrite only with the flag.
  fs.appendFileSync(file, '\nмоя строка\n');
  const text0 = fs.readFileSync(file, 'utf8').replace('\nмоя строка\n', '');
  fs.writeFileSync(file, text0.replace('## Тесты', '## Тесты (мои)'));
  check('правка руками: modified', (await bm(win, 'agents.skillStatus', { projectId: ID })).state === 'modified');
  const refused = await bm(win, 'agents.installSkill', { projectId: ID, dir: WORK }).then(() => null, (e) => String(e));
  check('без overwrite — отказ', !!refused && refused.includes('изменён вручную'), refused ?? 'записал');
  await bm(win, 'agents.installSkill', { projectId: ID, dir: WORK, overwrite: true });
  check('с overwrite — снова current', (await bm(win, 'agents.skillStatus', { projectId: ID })).state === 'current');

  // 3. Settings change → outdated, one line on Status.
  const doc = YAML.parseDocument((await bm(win, 'projects.get', { projectId: ID })).yaml);
  doc.setIn(['repo', 'fetchIntervalMin'], 7);
  await bm(win, 'projects.update', { projectId: ID, yaml: doc.toString() });
  check('настройки изменились: outdated', (await bm(win, 'agents.skillStatus', { projectId: ID })).state === 'outdated');
  const st = await bm(win, 'system.status', {});
  check('Status: skill устарел', st.outdatedSkills.some((k) => k.projectId === ID));
  await win.evaluate((id) => (location.hash = `#/projects/${id}/settings/agents`), ID);
  await pause(1500);
  await shot(win, 'agent-skill-outdated');
  await bm(win, 'agents.installSkill', { projectId: ID, dir: WORK });
  check('«Обновить» — current', (await bm(win, 'agents.skillStatus', { projectId: ID })).state === 'current');

  // 4. Builds carry the labels the skill reads.
  const rp = await rebuild(win, prodBr);
  check('Production собрана', rp.job.status === 'success' && rp.build.status === 'running', rp.job.error ?? rp.build.errorMessage ?? '');
  const rd = await rebuild(win, devBr);
  check('feature собрана', rd.job.status === 'success' && rd.build.status === 'running', rd.job.error ?? rd.build.errorMessage ?? '');
  const find = (b) => docker('ps', '-q', '--filter', `label=bm.project=${ID}`, '--filter', 'label=com.docker.compose.oneoff=False', '--filter', `label=bm.branch.name=${b}`);
  const cp = find('main');
  const cd = find('feature');
  check('labels Production', label(cp, 'bm.protected') === 'true' && label(cp, 'bm.slug') === 'prod', `${label(cp, 'bm.protected')} ${label(cp, 'bm.slug')}`);
  const args = label(cd, 'bm.odoo.args');
  check('labels feature', label(cd, 'bm.protected') === 'false' && label(cd, 'bm.url') === rd.build.url && args.includes('--addons-path=') && args.includes('--data-dir='), `${label(cd, 'bm.url')} | ${args}`);

  // 5. The commands of the skill, as written: -u and tests in Git Bash, -u in PowerShell.
  const skill = fs.readFileSync(file, 'utf8');
  const findBlock = blocks(skill, 'Найти сборку', 'bash')[0].split('\n').filter((l) => /^(C|DB)=/.test(l));
  const [bashU] = blocks(skill, 'Обновить модуль', 'bash');
  const [psU] = blocks(skill, 'Обновить модуль', 'powershell');
  const [bashT] = blocks(skill, 'Тесты', 'bash');
  const script = [...findBlock, ...bashU.split('\n')].map((l) => fill(l, 'feature')).join('\n');
  const q = "SELECT write_date FROM ir_module_module WHERE name='bm_probe'";
  const before = sql(rd.build.dbName, q);
  let out = execFileSync(BASH, ['-c', `set -e\n${script}`], { encoding: 'utf8' });
  check('Git Bash: -u из skill', sql(rd.build.dbName, q) !== before, out.trim().split('\n')[0]);
  await pause(3000);

  const helpers = bashU.split('\n').filter((l) => l.startsWith('ARGS=') || l.startsWith('bmodoo()'));
  const testScript = [...findBlock, ...helpers, bashT].map((l) => fill(l, 'feature')).join('\n');
  out = execFileSync(BASH, ['-c', `set -e\n{\n${testScript}\n} 2>&1 | tail -40`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  check('Git Bash: тесты из skill', /0 failed, 0 error\(s\) of [1-9]\d* tests?/.test(out), out.split('\n').filter((l) => /tests|ERROR|FAIL/.test(l)).slice(-3).join(' | '));

  const [shellLine] = blocks(skill, 'Логи, база, odoo shell', 'bash')[0].split('\n').filter((l) => l.includes('bmodoo shell'));
  out = execFileSync(BASH, ['-c', [...findBlock, ...helpers, shellLine].map((l) => fill(l, 'feature')).join('\n')], { encoding: 'utf8' });
  check('Git Bash: odoo shell из skill', /^\d+$/m.test(out.trim().split('\n').pop() ?? ''), out.trim().split('\n').pop());

  const before2 = sql(rd.build.dbName, q);
  out = execFileSync('powershell.exe', ['-NoProfile', '-Command', fill(psU, 'feature')], { encoding: 'utf8' });
  check('PowerShell: -u из skill', sql(rd.build.dbName, q) !== before2, out.trim().split('\n')[0] ?? '');
}

const { app, win } = await launch();
try {
  const state = await bm(win, 'system.state');
  if (state.firstRun) await bm(win, 'system.completeFirstRun', {});
  await run(win);
} catch (err) {
  check('без исключений', false, err.stack ?? err.message);
} finally {
  if ((await bm(win, 'projects.list')).some((p) => p.id === ID)) {
    const j = await waitJob(win, (await bm(win, 'projects.delete', { projectId: ID, confirm: ID })).jobId);
    console.log(`проект ${ID} удалён: ${j.status}`);
  }
  await app.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
  // The dev profile rewrote the shared bm-traefik with its own networks: the default profile's compose is put back.
  const own = path.join(process.env.LOCALAPPDATA, 'Odoo Branch Manager', 'traefik', 'compose.yml');
  if (fs.existsSync(own)) docker('compose', '-p', 'bm-traefik', '-f', own, 'up', '-d');
}
console.log(`Итого: ${results.filter(Boolean).length} из ${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
