// D69: the language switch in the header. Choosing a language changes the window at once and only `language` of
// app.yaml: the rest of the file (comments included) stays as it was.
import YAML from 'yaml';
import { launch, bm, shot } from './pw.mjs';

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};

const { app, win } = await launch();
win.setDefaultTimeout(30000);
const original = (await bm(win, 'config.get', { level: 'app' })).yaml;
try {
  // Start from Russian with a comment of our own, to see that the switch keeps the file.
  const doc = YAML.parseDocument(original);
  doc.set('language', 'ru');
  doc.commentBefore = ' header-language check';
  await bm(win, 'config.put', { level: 'app', yaml: doc.toString() });
  await win.evaluate(() => (location.hash = '#/status'));
  await win.waitForTimeout(2500);
  const button = win.locator('[data-testid="header-language"]');
  check('кнопка языка в шапке: RU', (await button.innerText()).trim() === 'RU', await button.innerText());

  await button.click();
  await win.getByRole('menuitem', { name: 'English' }).click();
  await win.waitForTimeout(2500);
  check('окно на английском', (await win.locator('[data-testid="header-language"]').innerText()).trim() === 'EN' && (await win.getByText('Interface language').count()) === 0 && (await win.locator('body').innerText()).includes('Docker'));
  const after = (await bm(win, 'config.get', { level: 'app' })).yaml;
  const was = YAML.parse(doc.toString());
  const now = YAML.parse(after);
  check('app.yaml: language = en', now.language === 'en', now.language);
  check('app.yaml: остальное не тронуто', JSON.stringify({ ...now, language: 'ru' }) === JSON.stringify(was));
  check('app.yaml: комментарий на месте', after.startsWith('# header-language check'), after.split('\n')[0]);
  await shot(win, 'header-language');

  await win.locator('[data-testid="header-language"]').click();
  await win.getByRole('menuitem', { name: 'Українська' }).click();
  await win.waitForTimeout(2500);
  check('обратно на украинский', YAML.parse((await bm(win, 'config.get', { level: 'app' })).yaml).language === 'uk');
  const audit = await bm(win, 'audit.list', { action: 'settings.update', limit: 5 });
  check('смена языка в аудите', audit.items.some((a) => a.diff?.includes('+ language: uk')));
} finally {
  await bm(win, 'config.put', { level: 'app', yaml: original });
  await app.close();
}
console.log(`Итого: ${results.filter(Boolean).length} из ${results.length}`);
