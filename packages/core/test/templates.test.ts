import { describe, expect, it } from 'vitest';
import {
  assertSqlIdent,
  literalPrefix,
  makeSlug,
  parseBranchName,
  renderDeep,
  renderTemplate,
  slugUnderscore,
  templateToRegex,
} from '../src/config/templates';

const demz = { template: '{branch}', strip: '^19\\.0-demz-' };

describe('makeSlug (spec 8.2)', () => {
  it('matches the DEMZ examples', () => {
    expect(makeSlug('19.0-demz-crm', demz)).toBe('crm');
    expect(makeSlug('19.0-eusign_cp', demz)).toBe('19-0-eusign-cp');
    expect(makeSlug('demz-roman', demz)).toBe('demz-roman');
    expect(makeSlug('19.0-demz-prerelease', demz)).toBe('prerelease');
    expect(makeSlug('19.0-demz-perevertum', demz)).toBe('perevertum');
  });

  it('lowercases, replaces / _ . and collapses dashes', () => {
    const o = { template: '{branch}', strip: null };
    expect(makeSlug('Feature/ABC__x..y', o)).toBe('feature-abc-x-y');
    expect(makeSlug('--a--b--', o)).toBe('a-b');
  });

  it('limits to 40 characters without a trailing dash', () => {
    const s = makeSlug('a'.repeat(39) + '-bbbb', { template: '{branch}', strip: null });
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith('-')).toBe(false);
  });

  it('adds -2, -3 on collision', () => {
    expect(makeSlug('19.0-demz-crm', { ...demz, taken: ['crm'] })).toBe('crm-2');
    expect(makeSlug('19.0-demz-crm', { ...demz, taken: ['crm', 'crm-2'] })).toBe('crm-3');
  });

  it('keeps the unstripped name if stripping leaves nothing', () => {
    expect(makeSlug('19.0-demz-', demz)).toBe('19-0-demz');
  });

  it('uses the slug template with parsed variables', () => {
    expect(makeSlug('feature/123-login', { template: '{type}-{issue}', strip: null, vars: { type: 'feature', issue: '123' } })).toBe('feature-123');
  });
});

describe('renderTemplate (spec 9.2)', () => {
  it('renders all DEMZ name templates', () => {
    const vars = { project: 'demz', slug: 'crm', slug_: slugUnderscore('eusign-cp'), build: 3 };
    expect(renderTemplate('o19_br_{slug_}_{build}', vars)).toBe('o19_br_eusign_cp_3');
    expect(renderTemplate('{slug}.localhost', vars)).toBe('crm.localhost');
    expect(renderTemplate('bm-{project}-{slug}', vars)).toBe('bm-demz-crm');
    expect(renderTemplate('https://github.com/DEMZ-UA/demz-odoo/issues/{issue}', { issue: 42 })).toBe(
      'https://github.com/DEMZ-UA/demz-odoo/issues/42',
    );
  });

  it('supports every documented variable', () => {
    const all = {
      project: 'p', branch: 'b', slug: 's', slug_: 's_', stage: 'development', build: 1, issue: '7', type: 'fix',
      db: 'd', host: 'h', debugPort: 5701, worktree: 'E:/w', repoMount: '/mnt/r', sha: 'abcdef1234', shortSha: 'abcdef1',
    };
    const tpl = Object.keys(all).map((k) => `{${k}}`).join('|');
    expect(renderTemplate(tpl, all)).toBe(Object.values(all).join('|'));
  });

  it('throws on unknown and on missing variables', () => {
    expect(() => renderTemplate('{nope}', {})).toThrow(/неизвестная переменная/);
    expect(() => renderTemplate('{issue}', { issue: null })).toThrow(/не определена/);
  });

  it('renders nested structures', () => {
    expect(renderDeep({ a: ['-d', '{db}'], b: { c: '^{db}$' } }, { db: 'x' })).toEqual({ a: ['-d', 'x'], b: { c: '^x$' } });
  });

  it('parses issue and type from branch names', () => {
    expect(parseBranchName('feature/123-login', '^(?<type>feature|fix)/(?<issue>\\d+)-')).toEqual({ issue: '123', type: 'feature' });
    expect(parseBranchName('main', '^(?<type>feature|fix)/(?<issue>\\d+)-')).toEqual({ issue: null, type: null });
    expect(parseBranchName('x', null)).toEqual({ issue: null, type: null });
  });
});

describe('identifiers and ownership regex', () => {
  it('accepts only [a-z0-9_] database names', () => {
    expect(assertSqlIdent('o19_br_crm_1')).toBe('o19_br_crm_1');
    expect(() => assertSqlIdent('o19-br')).toThrow();
    expect(() => assertSqlIdent('x"; DROP DATABASE postgres; --')).toThrow();
    expect(() => assertSqlIdent('A')).toThrow();
    expect(() => assertSqlIdent('a'.repeat(64))).toThrow();
  });

  it('builds a regex that recognises generated names only', () => {
    const re = templateToRegex('o19_br_{slug_}_{build}');
    expect(re.test('o19_br_crm_12')).toBe(true);
    expect(re.test('o19_br_eusign_cp_1')).toBe(true);
    expect(re.test('o19_test')).toBe(false);
    expect(re.test('o19_br_crm_x')).toBe(false);
    expect(literalPrefix('o19_br_{slug_}_{build}')).toBe('o19_br_');
  });
});
