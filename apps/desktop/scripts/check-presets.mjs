// D73: project export and saved presets. The sandbox project is exported (with and without this machine's paths) and
// saved as a preset; the wizard then lays that preset over a new detection of the sandbox repository and creates a
// project from it. Both projects are deleted at the end, the preset file too.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { launch, bm, shot } from './pw.mjs';
import { SANDBOX, ensureSandbox, waitJob, waitJobs } from './sandbox.mjs';

const ID = 'bmpre';
const ID2 = 'bmpre2';
const PRESET = 'Песочница тест';
const CLONE = `${SANDBOX}/demz-odoo`;
const EXPORT = `${SANDBOX}/export-${ID}.yaml`;
const EXPORT_PATHS = `${SANDBOX}/export-${ID}-paths.yaml`;
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

const { app, win } = await launch();
win.setDefaultTimeout(60000);
const original = (await bm(win, 'config.get', { level: 'app' })).yaml;
const setLanguage = async (lang) => {
  const doc = YAML.parseDocument((await bm(win, 'config.get', { level: 'app' })).yaml);
  doc.set('language', lang);
  await bm(win, 'config.put', { level: 'app', yaml: doc.toString() });
  await win.waitForTimeout(2500);
};
let presetFile = null;
try {
  await setLanguage('ru');
  await win.setViewportSize({ width: 1600, height: 950 });
  await ensureSandbox(win, {
    id: ID,
    postgres: 'managed',
    stages: { production: { buildOnAdd: false }, development: { buildOnAdd: false } },
  });
  await waitJobs(win, ID, 600000);
  const src = (await bm(win, 'projects.get', { projectId: ID })).config;

  // 1. Export.
  await bm(win, 'projects.export', { projectId: ID, path: EXPORT, keepPaths: false });
  const ex = fs.readFileSync(EXPORT, 'utf8');
  const exCfg = YAML.parse(ex);
  check('экспорт: заголовок', ex.startsWith(`# Экспорт проекта ${ID}`), ex.split('\n')[0]);
  check('экспорт: без пароля Postgres', !('password' in (exCfg.postgres ?? {})));
  check('экспорт: без путей', !exCfg.repo.mirrorDir && !exCfg.repo.worktreesDir && !exCfg.runtime.mounts && !exCfg.runtime.network);
  check('экспорт: настройки на месте', exCfg.id === ID && JSON.stringify(exCfg.branchRules) === JSON.stringify(src.branchRules));
  await bm(win, 'projects.export', { projectId: ID, path: EXPORT_PATHS, keepPaths: true });
  const exp = YAML.parse(fs.readFileSync(EXPORT_PATHS, 'utf8'));
  check('экспорт с путями: пути есть, пароля нет', exp.repo.mirrorDir === src.repo.mirrorDir && !('password' in exp.postgres));
  const asProject = await bm(win, 'presets.read', { path: EXPORT });
  check('экспорт читается как проект', asProject.kind === 'project' && asProject.config.id === ID, `${asProject.kind} ${asProject.base}`);

  // 2. Preset.
  const saved = await bm(win, 'presets.save', { projectId: ID, name: PRESET, base: 'demz' });
  presetFile = saved.file;
  const list = await bm(win, 'presets.list');
  check('пресет в списке', list.some((p) => p.file === saved.file && p.name === PRESET && p.from === ID), saved.file);
  const pr = await bm(win, 'presets.read', { file: saved.file });
  check('пресет без имён проекта', pr.kind === 'preset' && pr.config.id === undefined && pr.config.repo?.url === undefined && pr.config.naming?.db === undefined);
  const bad = await bm(win, 'presets.read', { file: '../app.yaml' }).then(
    () => null,
    (e) => String(e?.message ?? e),
  );
  check('чужой путь в file отклонён', !!bad, bad ?? 'прочитан');

  // 3. Interface: the project menu and the app card.
  await win.evaluate((id) => (location.hash = `#/projects/${id}/settings/repo`), ID);
  await win.getByRole('button', { name: 'Экспорт / пресет' }).click();
  check('меню проекта', await win.getByText('Сохранить как пресет…').isVisible());
  await shot(win, 'presets-menu');
  await win.keyboard.press('Escape');
  await win.evaluate(() => (location.hash = '#/settings/app'));
  await win.getByText(PRESET).first().waitFor();
  check('карточка «Пресеты» в настройках приложения', await win.getByText(saved.file).isVisible());
  await shot(win, 'presets-card');

  // 4. Wizard: the sandbox repository again, with the preset.
  await win.evaluate(() => (location.hash = '#/projects/new'));
  await win.getByText('Адрес из папки на диске').click();
  await win.getByLabel('Папка вашего клона').fill(CLONE);
  await win.getByRole('button', { name: 'Прочитать адрес' }).click();
  await win.getByText('Адрес:').waitFor();
  await win.getByRole('button', { name: 'Проверить доступ' }).click();
  await win.getByText('Доступ есть').waitFor();
  await win.getByRole('button', { name: 'Загрузить' }).click();
  await win.getByText('Копия приложения').waitFor({ timeout: 600000 });
  await win.locator('[data-testid="preset-overlay"]').click();
  await win.getByRole('option', { name: `${PRESET} (DEMZ)` }).click();
  await win.getByText(`Пресет «${PRESET}» поверх «DEMZ»`).waitFor();
  check('мастер: пресет выбран', true);
  await win.getByLabel('id проекта').fill(ID2);
  await win.waitForTimeout(500);
  await shot(win, 'presets-wizard');
  await win.getByRole('button', { name: 'Создать проект' }).click();
  await win.waitForFunction((id) => location.hash.includes(`/projects/${id}/`), ID2, { timeout: 120000 });
  await waitJobs(win, ID2, 600000);
  const made = (await bm(win, 'projects.get', { projectId: ID2 })).config;
  check('новый проект: настройки из пресета', JSON.stringify(made.branchRules) === JSON.stringify(src.branchRules) && JSON.stringify(made.runtime.command) === JSON.stringify(src.runtime.command));
  check('новый проект: свои имена', made.id === ID2 && made.runtime.network === `bm-${ID2}` && made.postgres.protectedContainers.includes(`bm-${ID2}-db`), `${made.runtime.network} ${made.postgres.protectedContainers.join(',')}`);
  check('новый проект: свой Postgres работает', docker('inspect', `bm-${ID2}-db`, '--format', '{{.State.Status}}') === 'running');
} finally {
  try {
    for (const id of [ID2, ID]) {
      if ((await bm(win, 'projects.list')).some((p) => p.id === id)) {
        const j = await waitJob(win, (await bm(win, 'projects.delete', { projectId: id, confirm: id })).jobId);
        console.log(`проект ${id} удалён:`, j.status);
      }
    }
    if (presetFile) await bm(win, 'presets.delete', { file: presetFile });
    check('пресет удалён', !(await bm(win, 'presets.list')).some((p) => p.file === presetFile));
    await bm(win, 'config.put', { level: 'app', yaml: original });
  } finally {
    await app.close();
    for (const f of [EXPORT, EXPORT_PATHS]) fs.rmSync(f, { force: true });
    const own = path.join(process.env.LOCALAPPDATA, 'Odoo Branch Manager', 'traefik', 'compose.yml');
    if (fs.existsSync(own)) docker('compose', '-p', 'bm-traefik', '-f', own, 'up', '-d');
  }
}
console.log(`Итого: ${results.filter(Boolean).length} из ${results.length}`);
