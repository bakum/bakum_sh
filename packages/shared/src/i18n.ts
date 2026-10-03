/**
 * Interface languages (docs/decisions.md D69). Every process keeps its own current language: Core and main read it
 * from app.yaml (`language`), the renderer from the same setting. Dictionaries live next to the code that uses them;
 * an entry holds all three languages, so a missing translation is a type error.
 *
 * Text syntax: `{name}` — a parameter; `{n:one|few|many}` (uk, ru) or `{n:one|other}` (en) — the plural form for the
 * number in parameter `n`. Braces without a matching parameter stay as they are (templates like `{slug}` in help text).
 */
export const LANGS = ['uk', 'ru', 'en'] as const;
export type Lang = (typeof LANGS)[number];
export const DEFAULT_LANG: Lang = 'uk';
export const LANG_NAMES: Record<Lang, string> = { uk: 'Українська', ru: 'Русский', en: 'English' };
/** BCP 47 locale for dates and numbers. en-GB keeps the 24-hour clock and day-first dates of the other two. */
export const LOCALES: Record<Lang, string> = { uk: 'uk-UA', ru: 'ru-RU', en: 'en-GB' };

export const isLang = (v: unknown): v is Lang => typeof v === 'string' && (LANGS as readonly string[]).includes(v);

let source: () => unknown = () => DEFAULT_LANG;

/** Where the current language comes from (a getter, so a changed setting applies without wiring). */
export function setLangSource(get: () => unknown): void {
  source = get;
}

export const setLang = (lang: Lang): void => setLangSource(() => lang);

export function getLang(): Lang {
  try {
    const l = source();
    return isLang(l) ? l : DEFAULT_LANG;
  } catch {
    return DEFAULT_LANG;
  }
}

export const locale = (lang: Lang = getLang()): string => LOCALES[lang];

export type Entry = Record<Lang, string>;
export type Params = Record<string, string | number | boolean | null | undefined>;

const PLURAL_ORDER: Record<Lang, string[]> = { uk: ['one', 'few', 'many', 'other'], ru: ['one', 'few', 'many', 'other'], en: ['one', 'other'] };
const rules = new Map<Lang, Intl.PluralRules>();

/** Picks the form for `n` from `forms` (uk/ru: one, few, many; en: one, other). */
export function pluralForm(n: number, forms: string[], lang: Lang = getLang()): string {
  let r = rules.get(lang);
  if (!r) rules.set(lang, (r = new Intl.PluralRules(LOCALES[lang])));
  const i = PLURAL_ORDER[lang].indexOf(r.select(n));
  return forms[Math.min(i < 0 ? forms.length - 1 : i, forms.length - 1)] ?? '';
}

const PLACEHOLDER = /\{(\w+)(?::([^{}]*))?\}/g;

export function format(text: string, params?: Params, lang: Lang = getLang()): string {
  if (!params) return text;
  return text.replace(PLACEHOLDER, (whole, name: string, forms: string | undefined) => {
    if (!(name in params)) return whole;
    const v = params[name];
    if (forms === undefined) return v === null || v === undefined ? '' : String(v);
    return pluralForm(Number(v), forms.split('|'), lang);
  });
}

/** Names of the parameters a text uses (for the dictionary consistency test). */
export function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]!))].sort();
}

export type Translate<K extends string> = (key: K, params?: Params) => string;

/** `t(key, params)` over a dictionary, in the current language. */
export function translator<D extends Record<string, Entry>>(dict: D): Translate<keyof D & string> {
  return (key, params) => {
    const lang = getLang();
    const e = dict[key];
    return e ? format(e[lang], params, lang) : key;
  };
}

const messages = {
  'scope.app': { uk: 'за замовчуванням', ru: 'по умолчанию', en: 'default' },
  'scope.project': { uk: 'з проєкту', ru: 'из проекта', en: 'from the project' },
  'scope.stage': { uk: 'зі стадії', ru: 'из стадии', en: 'from the stage' },
  'scope.rule': { uk: 'з правила', ru: 'из правила', en: 'from the rule' },
  'scope.branch': { uk: 'з гілки', ru: 'из ветки', en: 'from the branch' },
  'zod.database': {
    uk: 'очікується backup | fresh | copy:production | copy:<гілка>',
    ru: 'ожидается backup | fresh | copy:production | copy:<ветка>',
    en: 'expected backup | fresh | copy:production | copy:<branch>',
  },
  'zod.projectId': { uk: 'лише a-z, 0-9 і «-»', ru: 'только a-z, 0-9 и «-»', en: 'only a-z, 0-9 and «-»' },
  'zod.filestore': {
    uk: 'має закінчуватися на /filestore (батьківська папка — data_dir Odoo)',
    ru: 'должен заканчиваться на /filestore (родитель — data_dir Odoo)',
    en: 'must end with /filestore (its parent is the Odoo data_dir)',
  },
  'zod.repoUrl': {
    uk: 'потрібні repo.url і repo.mirrorDir (адреса репозиторію та копія застосунку)',
    ru: 'нужны repo.url и repo.mirrorDir (адрес репозитория и копия приложения)',
    en: 'repo.url and repo.mirrorDir are required (the repository address and the app’s copy)',
  },
  'zod.folderBranchOnly': {
    uk: 'folder задається лише в налаштуваннях гілки',
    ru: 'folder задаётся только в настройках ветки',
    en: 'folder is set only in the branch settings',
  },
  'zod.ownerRepo': { uk: 'очікується owner/repo', ru: 'ожидается owner/repo', en: 'expected owner/repo' },
  'zod.isoTime': { uk: 'очікується час ISO в UTC', ru: 'ожидается время ISO в UTC', en: 'expected an ISO time in UTC' },
  'zod.gitUrl': {
    uk: 'очікується https://…, git@…:owner/repo.git або file:///…',
    ru: 'ожидается https://…, git@…:owner/repo.git или file:///…',
    en: 'expected https://…, git@…:owner/repo.git or file:///…',
  },
  'zod.zipFile': { uk: 'потрібен файл .zip', ru: 'нужен файл .zip', en: 'a .zip file is required' },
  'error.validation': { uk: 'Некоректні дані: {issues}', ru: 'Некорректные данные: {issues}', en: 'Invalid data: {issues}' },
  'error.root': { uk: '(корінь)', ru: '(корень)', en: '(root)' },
  'error.internal': {
    uk: 'Внутрішня помилка: {message}. Подробиці — у журналі Core (Status → Відкрити папку журналів).',
    ru: 'Внутренняя ошибка: {message}. Подробности — в логе Core (Status → Открыть папку логов).',
    en: 'Internal error: {message}. Details are in the Core log (Status → Open logs folder).',
  },
} satisfies Record<string, Entry>;

/** Messages of the shared package (schema validation, error shapes). */
export const st = translator(messages);
export const sharedMessages: Record<string, Entry> = messages;
