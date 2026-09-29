// Adds the DEMZ project anew (D33) in the real profile, through the wizard UI: address from the user's clone →
// access check → the app's own copy → detection → DEMZ preset → «Создать проект» → first fetch. No builds are started.
import { launch, shot, bm } from './pw.mjs';
import { waitJobs } from './sandbox.mjs';

const FOLDER = 'E:\\demz-odoo-19\\repositories\\demz-odoo';
const step = (s) => console.log(`\n=== ${s}`);

const { app, win } = await launch({ BM_PROFILE: '' });
win.setDefaultTimeout(60000);
let code = 0;
try {
  const { paths } = await bm(win, 'system.status', {});
  console.log('настройки:', paths.configDir, '| данные:', paths.dataDir);
  if (/\(dev\)/.test(paths.configDir)) throw new Error('запущен тестовый профиль, а нужен рабочий');
  if ((await bm(win, 'projects.list')).some((p) => p.id === 'demz')) throw new Error('проект demz уже есть');

  step('Мастер: адрес из вашей папки');
  await win.evaluate(() => (location.hash = '#/projects/new'));
  await win.getByText('Адрес из папки на диске').click();
  await win.getByLabel('Папка вашего клона').fill(FOLDER);
  await win.getByRole('button', { name: 'Прочитать адрес' }).click();
  await win.getByText('Адрес:').waitFor();
  console.log(await win.getByText('Адрес:').first().textContent());

  step('Проверка доступа');
  await win.getByRole('button', { name: 'Проверить доступ' }).click();
  await win.getByText(/Доступ есть|Нет доступа/).first().waitFor({ timeout: 120000 });
  if (await win.getByText('Нет доступа').isVisible()) {
    await shot(win, 'demz-no-access');
    throw new Error('нет доступа к репозиторию: ' + (await win.getByText('Нет доступа').locator('..').textContent()));
  }
  console.log(await win.getByText('Доступ есть').textContent());

  step('Копия приложения');
  await win.getByRole('button', { name: 'Загрузить' }).click();
  await win.getByText(/Загружено в/).waitFor({ timeout: 1800000 });
  console.log(await win.getByText(/Загружено в/).textContent());
  await win.getByText('Копия приложения').waitFor({ timeout: 300000 });

  step('Определение и пресет');
  const presets = await win.locator('label').filter({ hasText: 'DEMZ' }).first();
  await presets.click();
  await new Promise((r) => setTimeout(r, 1500));
  for (const t of await win.locator('.mantine-Alert-message').allTextContents()) console.log('предупреждение:', t);
  await shot(win, 'demz-wizard');

  step('Создать проект');
  await win.getByRole('button', { name: 'Создать проект' }).click();
  await Promise.race([
    win.waitForURL(/#\/projects\/demz\/branches/, { timeout: 120000 }),
    win.getByText('Postgres недоступен').waitFor({ timeout: 120000 }).then(() => {
      throw new Error('мастер: Postgres недоступен — проект не создан');
    }),
  ]);
  await waitJobs(win, 'demz', 600000);
  const p = await bm(win, 'projects.get', { projectId: 'demz' });
  console.log('url:', p.config.repo.url, '| копия:', p.config.repo.mirrorDir, '| ваша папка:', p.config.repo.localFolder, '| старая схема:', p.summary.legacy);
  console.log('последний fetch:', p.summary.lastFetchAt, p.summary.lastFetchError ?? 'без ошибок');
  const l = await bm(win, 'branches.list', { projectId: 'demz' });
  for (const s of ['production', 'development']) console.log(`${s}: ${l[s].map((b) => `${b.name}${b.liveBuild ? ' (сборка)' : ''}`).join(', ')}`);
  await win.evaluate(() => (location.hash = '#/projects/demz/branches'));
  await new Promise((r) => setTimeout(r, 2500));
  await shot(win, 'demz-branches');
} catch (e) {
  console.log('ОШИБКА:', e.message);
  code = 1;
} finally {
  await app.close();
}
process.exit(code);
