import { describe, expect, it } from 'vitest';
import { projectConfigSchema } from '@bm/shared';
import { assertOwned, type OwnedRegistry } from '../src/safety';
import { demzPreset } from '../src/config/presets';

const cfg = projectConfigSchema.parse(
  demzPreset({
    id: 'demz',
    name: 'DEMZ',
    repo: { url: 'https://github.com/demz-ua/demz-odoo.git', mirrorDir: 'C:/bm/repos/demz-odoo.git', localFolder: 'E:/demz-odoo-19/repositories/demz-odoo' },
    github: null,
    remote: 'origin',
    projectRoot: 'E:/demz-odoo-19',
    worktreesDir: 'E:/demz-odoo-19/worktrees',
    moduleRoots: [],
    modulesToInstall: null,
    image: 'img',
    network: 'net',
    repoMount: '/mnt/repositories/demz-odoo',
    mounts: [],
    filestoreHostDir: 'E:/demz-odoo-19/data/filestore',
    postgres: { host: 'localhost', port: 5433, internalHost: 'db', user: 'odoo', password: 'x', protectedContainers: ['odoo19', 'odoo19-db'] },
    stackAddons: ['/usr/lib/python3/dist-packages/odoo/addons'],
    productionBranch: '19.0',
    odooVersion: '19.0',
  }),
);

const reg: OwnedRegistry = {
  dbNames: new Set(['o19_br_crm_3', 'o19_br_prod_1', 'o19_br_crm_3_test', 'o19_test']),
  composeProjects: new Set(['bm-demz-crm']),
  worktrees: new Set(['E:/demz-odoo-19/worktrees/demz/crm']),
};

describe('assertOwned', () => {
  it('allows registered build databases and their derived copies', () => {
    expect(() => assertOwned(cfg, { kind: 'db', name: 'o19_br_crm_3' }, reg)).not.toThrow();
    expect(() => assertOwned(cfg, { kind: 'db', name: 'o19_br_crm_3_test' }, reg)).not.toThrow();
  });

  it('refuses protected, foreign, unregistered or malformed databases', () => {
    expect(() => assertOwned(cfg, { kind: 'db', name: 'o19_test' }, reg)).toThrow(/защищена/);
    expect(() => assertOwned(cfg, { kind: 'db', name: 'postgres' }, reg)).toThrow(/защищена/);
    expect(() => assertOwned(cfg, { kind: 'db', name: 'o19_br_other_9' }, reg)).toThrow(/реестре/);
    expect(() => assertOwned(cfg, { kind: 'db', name: 'mydb' }, reg)).toThrow(/шаблону/);
    expect(() => assertOwned(cfg, { kind: 'db', name: 'o19_br_crm_3"; drop' }, reg)).toThrow(/допустимым/);
  });

  it('checks container labels and the protected list', () => {
    expect(() => assertOwned(cfg, { kind: 'container', name: 'bm-demz-crm-odoo-1', labels: { 'bm.project': 'demz' } }, reg)).not.toThrow();
    expect(() => assertOwned(cfg, { kind: 'container', name: 'odoo19', labels: { 'bm.project': 'demz' } }, reg)).toThrow(/защищён/);
    expect(() => assertOwned(cfg, { kind: 'container', name: 'x', labels: {} }, reg)).toThrow(/метки/);
    expect(() => assertOwned(cfg, { kind: 'container', name: 'x', labels: { 'bm.project': 'other' } }, reg)).toThrow(/метки/);
  });

  it('checks compose projects', () => {
    expect(() => assertOwned(cfg, { kind: 'compose', name: 'bm-demz-crm' }, reg)).not.toThrow();
    expect(() => assertOwned(cfg, { kind: 'compose', name: 'demz-odoo-19' }, reg)).toThrow(/шаблону/);
    expect(() => assertOwned(cfg, { kind: 'compose', name: 'bm-demz-prod' }, reg)).toThrow(/реестре/);
  });

  it('only removes registered worktrees inside worktreesDir, never the main checkout', () => {
    expect(() => assertOwned(cfg, { kind: 'worktree', path: 'E:\\demz-odoo-19\\worktrees\\demz\\crm' }, reg)).not.toThrow();
    expect(() => assertOwned(cfg, { kind: 'worktree', path: 'E:/demz-odoo-19/repositories/demz-odoo' }, reg)).toThrow(/вне папки/);
    expect(() => assertOwned(cfg, { kind: 'worktree', path: 'E:/demz-odoo-19/worktrees' }, reg)).toThrow(/вне папки/);
    expect(() => assertOwned(cfg, { kind: 'worktree', path: 'E:/demz-odoo-19/worktrees/demz/x' }, reg)).toThrow(/реестре/);
  });

  it('only removes the filestore directory of an owned database', () => {
    expect(() => assertOwned(cfg, { kind: 'filestore', path: 'E:/demz-odoo-19/data/filestore/o19_br_crm_3', db: 'o19_br_crm_3' }, reg)).not.toThrow();
    expect(() => assertOwned(cfg, { kind: 'filestore', path: 'E:/demz-odoo-19/data/filestore', db: 'o19_br_crm_3' }, reg)).toThrow(/не является/);
    expect(() => assertOwned(cfg, { kind: 'filestore', path: 'E:/demz-odoo-19/data/filestore/o19_test', db: 'o19_test' }, reg)).toThrow(/защищена/);
  });
});
