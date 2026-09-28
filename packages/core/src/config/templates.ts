import { BmError } from '@bm/shared';

/** Template variables (spec 9.2). */
export const TEMPLATE_VARS = [
  'project',
  'branch',
  'slug',
  'slug_',
  'stage',
  'build',
  'issue',
  'type',
  'db',
  'host',
  'debugPort',
  'worktree',
  'repoMount',
  'sha',
  'shortSha',
  'name',
  'module',
] as const;
export type TemplateVar = (typeof TEMPLATE_VARS)[number];
export type TemplateVars = Partial<Record<TemplateVar, string | number | null | undefined>>;

const VAR_RE = /\{([A-Za-z_]+)\}/g;

export function templateVariables(tpl: string): string[] {
  return [...tpl.matchAll(VAR_RE)].map((m) => m[1]!);
}

/** Replaces `{var}`; unknown or missing variables are errors (a silent empty string could produce a wrong resource name). */
export function renderTemplate(tpl: string, vars: TemplateVars): string {
  return tpl.replace(VAR_RE, (whole, name: string) => {
    if (!(TEMPLATE_VARS as readonly string[]).includes(name)) {
      throw new BmError('TEMPLATE_UNKNOWN_VAR', `Шаблон «${tpl}»: неизвестная переменная ${whole}. Допустимые: ${TEMPLATE_VARS.map((v) => `{${v}}`).join(', ')}`);
    }
    const v = vars[name as TemplateVar];
    if (v === undefined || v === null || v === '') {
      throw new BmError('TEMPLATE_MISSING_VAR', `Шаблон «${tpl}»: переменная ${whole} здесь не определена`);
    }
    return String(v);
  });
}

/** Renders every string inside a nested structure (used for command, env, path mappings). */
export function renderDeep<T>(value: T, vars: TemplateVars): T {
  if (typeof value === 'string') return renderTemplate(value, vars) as T;
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, vars)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderDeep(v, vars)])) as T;
  }
  return value;
}

export const SQL_IDENT_RE = /^[a-z0-9_]+$/;

/** Every database name built by the app goes through this check (spec 11). */
export function assertSqlIdent(name: string, what = 'имя БД'): string {
  if (!SQL_IDENT_RE.test(name) || name.length > 63) {
    throw new BmError('BAD_IDENTIFIER', `Недопустимое ${what} «${name}»: разрешены только a-z, 0-9, «_», до 63 символов. Проверьте шаблон naming.db.`);
  }
  return name;
}

export const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export function assertHost(host: string): string {
  if (!HOST_RE.test(host) || host.length > 253) {
    throw new BmError('BAD_HOST', `Недопустимое имя хоста «${host}». Проверьте шаблон naming.host.`);
  }
  return host;
}

export interface SlugOptions {
  template: string;
  strip: string | null;
  vars?: TemplateVars;
  taken?: Iterable<string>;
}

/** Slug from a branch name (spec 8.2): template → strip → lower → [^a-z0-9]→'-' → collapse → ≤40 → collision suffix. */
export function makeSlug(branch: string, opts: SlugOptions): string {
  const raw = renderTemplate(opts.template, { branch, ...opts.vars });
  let s = raw;
  if (opts.strip) {
    const stripped = raw.replace(new RegExp(opts.strip), '');
    if (normalizeSlug(stripped)) s = stripped;
  }
  let base = normalizeSlug(s) || 'branch';
  base = base.slice(0, 40).replace(/-+$/, '');
  const taken = new Set(opts.taken ?? []);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const suffix = `-${i}`;
    const candidate = base.slice(0, 40 - suffix.length).replace(/-+$/, '') + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

function normalizeSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export const slugUnderscore = (slug: string): string => slug.replace(/-/g, '_');

/** Issue / type from a branch name by `naming.parse` (named groups `issue`, `type`). */
export function parseBranchName(branch: string, parse: string | null): { issue: string | null; type: string | null } {
  if (!parse) return { issue: null, type: null };
  const m = new RegExp(parse).exec(branch);
  return { issue: m?.groups?.issue ?? null, type: m?.groups?.type ?? null };
}

/**
 * Regex matching every name a template can produce. Variables become `[a-z0-9_-]+` (`{build}` → digits).
 * Used to recognise the app's own databases / compose projects.
 */
export function templateToRegex(tpl: string): RegExp {
  let out = '';
  let last = 0;
  for (const m of tpl.matchAll(VAR_RE)) {
    out += escapeRe(tpl.slice(last, m.index));
    out += m[1] === 'build' || m[1] === 'debugPort' ? '\\d+' : '[a-z0-9_-]+';
    last = m.index! + m[0].length;
  }
  out += escapeRe(tpl.slice(last));
  return new RegExp(`^${out}$`);
}

export function literalPrefix(tpl: string): string {
  const i = tpl.indexOf('{');
  return i < 0 ? tpl : tpl.slice(0, i);
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
