// D37 in the sandbox: a project YAML that still names Staging is migrated on save (stages.staging → the staging rule's
// overrides, rule → development), the sidebar shows Production and Development only, «Скрыть» / «Показать» in the
// context menu hide a branch and bring it back. No builds are started.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { launch, shot, bm } from './pw.mjs';
import { ensureSandbox, waitJob, waitJobs, branch } from './sandbox.mjs';

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8' }).trim();

const { app, win } = await launch();
let ID = null;
try {
  ID = await ensureSandbox(win);

  // 1. Old-style YAML with Staging.
  const cur = await bm(win, 'projects.get', { projectId: ID });
  const doc = YAML.parseDocument(cur.yaml);
  doc.setIn(['stages', 'staging'], { database: 'copy:production', protected: true, dropAfterDays: 30 });
  doc.set('branchRules', [
    { match: ['19.0-demz-crm', '19.0-demz-prerelease'], stage: 'staging', overrides: { dropAfterDays: 7 } },
    ...(cur.config.branchRules ?? []),
  ]);
  await bm(win, 'projects.update', { projectId: ID, yaml: doc.toString() });
  const after = await bm(win, 'projects.get', { projectId: ID });
  check('YAML без staging после сохранения', !after.yaml.includes('staging'));
  const rule = after.config.branchRules[0];
  check(
    'настройки Staging перенесены в правило',
    rule.stage === 'development' &&
      JSON.stringify(rule.overrides, Object.keys(rule.overrides).sort()) === JSON.stringify({ database: 'copy:production', dropAfterDays: 7, protected: true }),
    JSON.stringify(rule),
  );

  // 2. Branches: two stages.
  await bm(win, 'git.fetch', { projectId: ID });
  await waitJobs(win, ID);
  const l = await bm(win, 'branches.list', { projectId: ID });
  check('в списке нет staging', !('staging' in l), Object.keys(l).join(','));
  const crm = await branch(win, ID, '19.0-demz-crm');
  check('crm в Development с правилом', crm?.stage === 'development' && crm.protected === true, `${crm?.stage} protected=${crm?.protected}`);
  await win.evaluate(([pid, id]) => (location.hash = `#/projects/${pid}/branches/${id}`), [ID, crm.id]);
  await win.waitForTimeout(2000);
  check('в сайдбаре нет группы Staging', !(await win.isVisible('[data-testid="stage-staging"]')) && (await win.isVisible('[data-testid="stage-development"]')));
  await shot(win, 'd37-two-stages');

  // 3. Hide / show through the context menu.
  const sel = '[data-testid="branch-19.0-demz-crm"]';
  await win.click(sel, { button: 'right' });
  await win.click('text=Скрыть');
  await win.waitForTimeout(1500);
  check('ветка скрыта', (await bm(win, 'branches.get', { branchId: crm.id })).hidden === true && !(await win.isVisible(sel)));
  check('кнопка «Показать скрытые (1)»', await win.isVisible('text=Показать скрытые (1)'));
  await shot(win, 'd37-hidden');
  await win.fill('input[placeholder="Filter branches…"]', 'crm');
  await win.waitForTimeout(500);
  check('поиск находит скрытую', await win.isVisible(sel));
  await win.fill('input[placeholder="Filter branches…"]', '');
  await win.click('[data-testid="toggle-hidden"]');
  await win.waitForTimeout(500);
  await shot(win, 'd37-show-hidden');
  await win.click(sel, { button: 'right' });
  await win.click('text=Показать');
  await win.waitForTimeout(1500);
  check('ветка снова видна', (await bm(win, 'branches.get', { branchId: crm.id })).hidden === false && (await win.isVisible(sel)));
  check('кнопка скрытых пропала', !(await win.isVisible('[data-testid="toggle-hidden"]')));
  const prod = (await bm(win, 'branches.list', { projectId: ID })).production[0];
  const err = await bm(win, 'branches.setHidden', { branchId: prod.id, hidden: true }).then(() => null, (e) => String(e));
  check('продакшн-ветку скрыть нельзя', !!err, err ?? '');
} finally {
  if (ID && (await bm(win, 'projects.list')).some((p) => p.id === ID)) {
    const j = await waitJob(win, (await bm(win, 'projects.delete', { projectId: ID, confirm: ID })).jobId);
    console.log('песочница удалена:', j.status);
  }
  await app.close();
  // The sandbox profile rewrote the shared bm-traefik with its own networks: the default profile's compose is put back.
  const own = path.join(process.env.LOCALAPPDATA, 'Odoo Branch Manager', 'traefik', 'compose.yml');
  if (fs.existsSync(own)) docker('compose', '-p', 'bm-traefik', '-f', own, 'up', '-d');
}
console.log(`Итого: ${results.filter(Boolean).length} из ${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
