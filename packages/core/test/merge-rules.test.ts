import { describe, expect, it } from 'vitest';
import { projectConfigSchema } from '@bm/shared';
import { mergeLevels, unsetPath } from '../src/config/merge';
import { selectStage, shouldAutoAdd, globToRegex } from '../src/config/rules';
import { resolveBranchScope } from '../src/config/effective';
import { demzPreset } from '../src/config/presets';

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
    mounts: [],
    filestoreHostDir: 'E:/demz-odoo-19/data/filestore',
    postgres: { host: 'localhost', port: 5433, internalHost: 'db', user: 'odoo', password: 'odoo', protectedContainers: ['odoo19', 'odoo19-db'] },
    stackAddons: ['/usr/lib/python3/dist-packages/odoo/addons'],
    productionBranch: '19.0',
    odooVersion: '19.0',
  }),
);

describe('mergeLevels (spec 9.1)', () => {
  it('merges objects by key, replaces arrays and scalars, tracks the source level', () => {
    const r = mergeLevels([
      { level: 'app', value: { a: 1, obj: { x: 1, y: 2 }, list: [1, 2], env: { A: '1' } } },
      { level: 'project', value: { env: { B: '2' } } },
      { level: 'stage', value: { obj: { y: 3 }, list: [9] } },
      { level: 'branch', value: { a: 5 } },
    ]);
    expect(r.value).toEqual({ a: 5, obj: { x: 1, y: 3 }, list: [9], env: { A: '1', B: '2' } });
    expect(r.sources).toMatchObject({ a: 'branch', 'obj.x': 'app', 'obj.y': 'stage', list: 'stage', 'env.A': 'app', 'env.B': 'project' });
  });

  it('replaces union-shaped fields as a whole', () => {
    const r = mergeLevels([
      { level: 'app', value: { updateModules: { list: ['a'] } } },
      { level: 'stage', value: { updateModules: { installedMatching: ['td_*'] } } },
    ]);
    expect(r.value).toEqual({ updateModules: { installedMatching: ['td_*'] } });
    expect(r.sources.updateModules).toBe('stage');
  });

  it('does not mutate inputs', () => {
    const app = { obj: { x: 1 } };
    mergeLevels([
      { level: 'app', value: app },
      { level: 'branch', value: { obj: { x: 2 } } },
    ]);
    expect(app.obj.x).toBe(1);
  });

  it('unsetPath removes a leaf and prunes empty parents', () => {
    expect(unsetPath({ tests: { mode: 'none' }, a: 1 }, 'tests.mode')).toEqual({ a: 1 });
  });
});

describe('branch rules (spec 8.2)', () => {
  it('lays out DEMZ branches like odoo.sh', () => {
    expect(selectStage(demz, '19.0').stage).toBe('production');
    expect(selectStage(demz, 'backup/19.0-demz-prerelease-before-demzua-sync-2026-09-25').stage).toBe('ignore');
    for (const b of ['19.0-demz-crm', '19.0-demz-prerelease', '19.0-demz-test1', '19.0-eusign_cp', 'demz-roman', '19.0-demz-perevertum']) {
      expect(selectStage(demz, b)).toMatchObject({ stage: 'development', ruleIndex: 1 });
    }
  });

  it('first matching rule wins', () => {
    const cfg = { ...demz, branchRules: [{ match: '19.0-*', stage: 'development' as const }, { match: '19.0-demz-*', stage: 'ignore' as const }] };
    expect(selectStage(cfg, '19.0-demz-x')).toMatchObject({ stage: 'development', ruleIndex: 0 });
  });

  it('supports regex matches and globs across slashes', () => {
    const cfg = { ...demz, branchRules: [{ match: { regex: '^feat/\\d+' }, stage: 'ignore' as const }] };
    expect(selectStage(cfg, 'feat/12-x').stage).toBe('ignore');
    expect(selectStage(cfg, 'feat/x')).toMatchObject({ stage: 'development', ruleIndex: null });
    expect(globToRegex('backup/*').test('backup/a/b')).toBe(true);
    expect(globToRegex('19.0').test('1900')).toBe(false);
  });

  it('honours autoAddBranches modes', () => {
    expect(shouldAutoAdd({ ...demz, autoAddBranches: 'none' }, 'demz-roman')).toBeNull();
    expect(shouldAutoAdd({ ...demz, autoAddBranches: 'all' }, 'backup/x')).toBeNull();
    const rulesOnly = { ...demz, autoAddBranches: 'rules' as const, branchRules: [{ match: '19.0-demz-crm', stage: 'development' as const }] };
    expect(shouldAutoAdd(rulesOnly, '19.0-demz-crm')?.stage).toBe('development');
    expect(shouldAutoAdd(rulesOnly, 'demz-roman')).toBeNull();
    expect(shouldAutoAdd({ ...rulesOnly, autoAddBranches: 'all' }, 'demz-roman')?.stage).toBe('development');
  });
});

describe('resolveBranchScope', () => {
  it('reports the level each effective value comes from', () => {
    const r = resolveBranchScope(demz, 'demz-roman', 'development', { onNewCommit: 'new' });
    const f = Object.fromEntries(r.fields.map((x) => [x.path, x]));
    expect(f.idleStopHours).toMatchObject({ value: 8, level: 'stage' });
    expect(f.onNewCommit).toMatchObject({ value: 'new', level: 'branch' });
    expect(f.database).toMatchObject({ value: 'copy:production', level: 'stage' });
    expect(f.image).toMatchObject({ value: 'demz-odoo-19-odoo', level: 'project' });
    expect(f['localTweaks.baseUrl']).toMatchObject({ value: true, level: 'app' });
    expect(f.env).toMatchObject({ value: { HOST: 'db' }, level: 'project' });
    expect(r.ruleIndex).toBe(1);
  });

  it('uses stage defaults of the current stage after a move to Production', () => {
    const r = resolveBranchScope(demz, 'demz-roman', 'production', { folder: 'D:/work/demz' });
    expect(r.scope.folder).toBeNull();
    expect(r.scope.database).toBe('backup');
    expect(r.ruleIndex).toBeNull();
  });
});
