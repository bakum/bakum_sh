import { afterEach, describe, expect, it } from 'vitest';
import { format, LANGS, placeholders, setLang, sharedMessages, type Entry } from '@bm/shared';
import { coreMessages, t } from '../src/i18n';
import { commits } from '../src/services/code-lag';
// The desktop dictionaries have no test runner of their own; their entries only need @bm/shared.
import { mainMessages } from '../../../apps/desktop/src/main/i18n';
import { messages as rendererMessages } from '../../../apps/desktop/src/renderer/src/i18n/messages';

const dictionaries: [string, Record<string, Entry>][] = [
  ['core', coreMessages],
  ['shared', sharedMessages],
  ['main', mainMessages],
  ['renderer', rendererMessages],
];

describe('i18n (D69)', () => {
  afterEach(() => setLang('ru'));

  it.each(dictionaries)('%s: every language has the text and the same parameters', (_name, dict) => {
    const bad: string[] = [];
    for (const [key, e] of Object.entries(dict)) {
      for (const l of LANGS) if (!e[l]?.trim()) bad.push(`${key}: empty ${l}`);
      const uk = placeholders(e.uk).join(',');
      for (const l of LANGS) if (placeholders(e[l]).join(',') !== uk) bad.push(`${key}: ${l} {${placeholders(e[l])}} ≠ uk {${uk}}`);
    }
    expect(bad).toEqual([]);
  });

  it('formats parameters and plural forms by language', () => {
    expect(format('{n} {n:коміт|коміти|комітів}', { n: 1 }, 'uk')).toBe('1 коміт');
    expect(format('{n} {n:коміт|коміти|комітів}', { n: 3 }, 'uk')).toBe('3 коміти');
    expect(format('{n} {n:коміт|коміти|комітів}', { n: 11 }, 'uk')).toBe('11 комітів');
    expect(format('{n} {n:commit|commits}', { n: 1 }, 'en')).toBe('1 commit');
    expect(format('{n} {n:commit|commits}', { n: 21 }, 'en')).toBe('21 commits');
    // Braces without a parameter are kept: templates in help texts.
    expect(format('naming.db: {build} {x}', { x: 'y' }, 'en')).toBe('naming.db: {build} y');
  });

  it('follows the current language', () => {
    setLang('uk');
    expect(commits(22)).toBe('22 коміти');
    expect(t('queue.noJob')).toBe('Завдання не знайдено');
    setLang('en');
    expect(commits(5)).toBe('5 commits');
    expect(t('queue.noJob')).toBe('Job not found');
  });
});
