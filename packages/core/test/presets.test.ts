import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { overlayConfig, projectConfigSchema, type ProjectConfig } from '@bm/shared';
import { demzPreset, odooPreset } from '../src/config/presets';
import { applyPresetText, exportProjectText, guessBase, parsePresetFile, presetFileName, presetText } from '../src/services/presets';

const demz = projectConfigSchema.parse(
  demzPreset({
    id: 'demz',
    name: 'DEMZ Odoo 19',
    repo: { url: 'https://github.com/demz-ua/demz-odoo.git', mirrorDir: 'C:/bm/repos/demz-odoo.git', localFolder: 'E:/demz-odoo-19/repositories/demz-odoo' },
    github: 'DEMZ-UA/demz-odoo',
    remote: 'origin',
    projectRoot: 'E:/demz-odoo-19',
    worktreesDir: 'E:/demz-odoo-19/worktrees',
    moduleRoots: [],
    modulesToInstall: null,
    image: 'demz-odoo-19-odoo',
    network: 'demz-odoo-19_default',
    repoMount: '/mnt/repositories/demz-odoo',
    mounts: [{ host: 'E:/demz-odoo-19/config/odoo.conf', container: '/etc/odoo/odoo.conf', readOnly: true }],
    filestoreHostDir: 'E:/demz-odoo-19/data/filestore',
    postgres: { host: 'localhost', port: 5433, internalHost: 'db', user: 'odoo', password: 'secret-pw', protectedContainers: ['odoo19', 'odoo19-db'] },
    stackAddons: ['/usr/lib/python3/dist-packages/odoo/addons'],
    productionBranch: '19.0',
    odooVersion: '19.0',
  }),
);
const withSecrets = { ...demz, connect: { adminPassword: 'admin-pw' } };
// As the store keeps it: the header line, then the YAML with the user's own comment.
const projectFile = `# Настройки проекта Odoo Branch Manager. Правка файла подхватывается автоматически.\n${YAML.stringify(withSecrets).replace(
  'branchRules:',
  '# rules of DEMZ\nbranchRules:',
)}`;

describe('project export (D73)', () => {
  it('drops secrets and this machine’s paths, keeps comments', () => {
    const text = exportProjectText(projectFile, { keepPaths: false, projectId: 'demz' });
    expect(text).not.toContain('secret-pw');
    expect(text).not.toContain('admin-pw');
    expect(text).not.toContain('E:/demz-odoo-19/worktrees');
    expect(text).not.toContain('E:/demz-odoo-19/data');
    expect(text).not.toContain('C:/bm/repos');
    expect(text).toMatch(/^# Экспорт проекта demz/);
    expect(text).toContain('# rules of DEMZ');
    expect(text).not.toContain('Правка файла подхватывается');
    expect(text).toMatch(/Убрано: .*postgres\.password.*repo\.mirrorDir/);
    const cfg = YAML.parse(text);
    expect(cfg.id).toBe('demz');
    expect(cfg.repo.url).toBe('https://github.com/demz-ua/demz-odoo.git');
    expect(cfg.runtime.mounts).toBeUndefined();
    expect(cfg.postgres.user).toBe('odoo');
    expect(cfg.postgres.port).toBeUndefined();
  });

  it('keeps the paths by choice, never the passwords', () => {
    const text = exportProjectText(projectFile, { keepPaths: true, projectId: 'demz' });
    expect(text).not.toContain('secret-pw');
    expect(text).toContain('E:/demz-odoo-19/worktrees');
    const back = projectConfigSchema.parse(YAML.parse(text));
    expect(back.postgres.password).toBe('');
    expect(back.runtime.mounts).toEqual(demz.runtime.mounts);
  });

  it('is laid over a detected proposal into a valid project', () => {
    const overlay = parsePresetFile(exportProjectText(projectFile, { keepPaths: false, projectId: 'demz' }), 'demz.yaml');
    expect(overlay.kind).toBe('project');
    expect(overlay.base).toBe('demz');
    const proposal: ProjectConfig = { ...demz, id: 'demz-2', repo: { ...demz.repo, mirrorDir: 'D:/other/demz.git', worktreesDir: 'D:/wt' }, postgres: { ...demz.postgres, password: '' } };
    const merged = projectConfigSchema.parse(overlayConfig(proposal, overlay.config));
    expect(merged.id).toBe('demz');
    expect(merged.repo.mirrorDir).toBe('D:/other/demz.git');
    expect(merged.repo.worktreesDir).toBe('D:/wt');
    expect(merged.branchRules).toEqual(demz.branchRules);
  });
});

describe('presets (D73)', () => {
  const text = presetText(projectFile, { name: 'DEMZ без тестов', base: 'demz', from: 'demz' });

  it('keeps the settings, not the project’s identity', () => {
    const doc = YAML.parse(text);
    expect(doc.preset).toMatchObject({ name: 'DEMZ без тестов', base: 'demz', from: 'demz' });
    expect(doc.config.id).toBeUndefined();
    expect(doc.config.name).toBeUndefined();
    expect(doc.config.repo.url).toBeUndefined();
    expect(doc.config.naming.db).toBeUndefined();
    expect(doc.config.production.branch).toBeUndefined();
    expect(doc.config.runtime.command).toEqual(demz.runtime.command);
    expect(doc.config.branchRules).toEqual(demz.branchRules);
    expect(text).not.toContain('secret-pw');
    expect(text).toContain('# rules of DEMZ');
  });

  it('gives the wizard the settings over another repository', () => {
    const overlay = parsePresetFile(text, 'p.yaml');
    expect(overlay).toMatchObject({ kind: 'preset', name: 'DEMZ без тестов', base: 'demz' });
    const proposal = { ...demz, id: 'shop', name: 'Shop', repo: { ...demz.repo, url: 'https://example.com/shop.git' }, naming: { ...demz.naming, db: 'shop_{slug_}_{build}' } };
    const merged = projectConfigSchema.parse(overlayConfig(proposal, overlay.config));
    expect(merged.id).toBe('shop');
    expect(merged.repo.url).toBe('https://example.com/shop.git');
    expect(merged.naming.db).toBe('shop_{slug_}_{build}');
    expect(merged.runtime.command).toEqual(demz.runtime.command);
  });

  it('drops secrets of a hand-made file and rejects what is not settings', () => {
    const hand = parsePresetFile('preset: { name: x, base: nope }\nconfig:\n  postgres: { password: pw, user: u }\n  connect: { adminPassword: a }\n', 'h.yaml');
    expect(hand.config).toEqual({ postgres: { user: 'u' }, connect: {} });
    expect(hand.base).toBe('generic');
    expect(() => parsePresetFile('- a\n- b\n', 'l.yaml')).toThrow(/не похож/);
    expect(() => parsePresetFile('foo: 1\n', 'f.yaml')).toThrow(/не похож/);
    expect(() => parsePresetFile('a: [', 'b.yaml')).toThrow(/не YAML/);
  });

  it('guesses the built-in preset and names the file', () => {
    const odoo = odooPreset({
      id: 'shop',
      name: 'Shop',
      repo: { url: 'https://example.com/shop.git', mirrorDir: 'C:/bm/repos/shop.git', localFolder: null },
      repoName: 'shop',
      github: null,
      remote: 'origin',
      worktreesDir: 'C:/bm/worktrees',
      moduleRoots: [],
      modulesToInstall: null,
      productionBranch: 'main',
      odooVersion: '18.0',
      filestoreHostDir: 'C:/bm/filestore/shop',
      pgPort: 5501,
      enterpriseDir: null,
    }) as Record<string, unknown>;
    expect(guessBase(odoo)).toBe('odoo');
    expect(guessBase(demz as unknown as Record<string, unknown>)).toBe('demz');
    expect(guessBase({ id: 'x', runtime: { image: 'my-odoo' } })).toBe('generic');
    expect(presetFileName('DEMZ без тестов!')).toBe('demz.yaml');
    expect(presetFileName('Мой')).toMatch(/^preset-\d+\.yaml$/);
  });
});

describe('applying a preset to a project (D73)', () => {
  it('changes the settings, keeps the project, its paths, passwords and comments', () => {
    const other = { ...withSecrets, id: 'other', name: 'Other', repo: { ...withSecrets.repo, url: 'https://example.com/o.git', worktreesDir: 'D:/elsewhere' }, autoAddBranches: 'rules', branchRules: [{ match: 'x/*', stage: 'development' }] };
    const preset = parsePresetFile(presetText(YAML.stringify(other), { name: 'p', base: 'demz', from: 'other' }), 'p.yaml');
    const text = applyPresetText(projectFile, preset);
    const cfg = projectConfigSchema.parse(YAML.parse(text));
    expect(cfg.autoAddBranches).toBe('rules');
    expect(cfg.branchRules).toEqual([{ match: 'x/*', stage: 'development' }]);
    expect(cfg.id).toBe('demz');
    expect(cfg.repo.url).toBe(demz.repo.url);
    expect(cfg.repo.worktreesDir).toBe(demz.repo.worktreesDir);
    expect(cfg.postgres.password).toBe('secret-pw');
    expect(text).toContain('Правка файла подхватывается');
  });

  it('takes an exported project as a preset: its id, paths and names do not move in', () => {
    const exported = parsePresetFile(exportProjectText(YAML.stringify({ ...demz, id: 'shop', name: 'Shop', autoAddBranches: 'none' }), { keepPaths: true, projectId: 'shop' }), 'shop.yaml');
    const cfg = projectConfigSchema.parse(YAML.parse(applyPresetText(projectFile, exported)));
    expect(cfg.id).toBe('demz');
    expect(cfg.name).toBe('DEMZ Odoo 19');
    expect(cfg.autoAddBranches).toBe('none');
    expect(cfg.runtime.mounts).toEqual(demz.runtime.mounts);
  });
});
