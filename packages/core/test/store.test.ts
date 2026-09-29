import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { projectConfigSchema, type ProjectConfig } from '@bm/shared';
import { checkCrossProject, ConfigStore, validateProject } from '../src/config/store';
import { genericPreset } from '../src/config/presets';

function cfg(id: string, over: Partial<ProjectConfig['naming']> = {}): ProjectConfig {
  const c = projectConfigSchema.parse(
    genericPreset({
      id,
      name: id,
      repo: { url: 'https://github.com/o/r.git', mirrorDir: 'C:/bm/repos/r.git', localFolder: null },
      github: null,
      remote: 'origin',
      projectRoot: null,
      worktreesDir: 'C:/w',
      moduleRoots: [],
      modulesToInstall: null,
      image: 'odoo:19',
      network: 'n',
      repoMount: '/mnt/r',
      mounts: [],
      filestoreHostDir: 'C:/fs',
      postgres: { host: 'localhost', port: 5432, internalHost: 'db', user: 'odoo', password: '', protectedContainers: [] },
      addonsDirs: [''],
      productionBranch: 'main',
      odooVersion: '19.0',
    }),
  );
  return { ...c, naming: { ...c.naming, ...over } };
}

describe('project validation', () => {
  it('rejects DB templates without {build} or without a literal prefix', () => {
    expect(() => validateProject(cfg('aa', { db: 'x_{slug_}' }))).toThrow(/\{build\}/);
    expect(() => validateProject(cfg('aa', { db: '{slug_}_{build}' }))).toThrow(/префикс/);
    expect(() => validateProject(cfg('aa', { db: 'O19-{slug_}_{build}' }))).toThrow(/недопустимое/);
    expect(() => validateProject(cfg('aa'))).not.toThrow();
  });

  it('detects overlapping DB prefixes and hosts between projects', () => {
    const demz = cfg('demz', { db: 'o19_br_{slug_}_{build}', host: '{slug}.localhost' });
    expect(() => checkCrossProject(cfg('dev', { db: 'o19_bmdev_{slug_}_{build}', host: '{slug}.dev.localhost' }), [demz])).not.toThrow();
    expect(() => checkCrossProject(cfg('xx', { db: 'o19_b{slug_}_{build}', host: '{slug}.x.localhost' }), [demz])).toThrow(/naming\.db/);
    expect(() => checkCrossProject(cfg('xx', { db: 'x_{slug_}_{build}', host: '{slug}.localhost' }), [demz])).toThrow(/naming\.host/);
  });
});

describe('ConfigStore', () => {
  it('writes, reloads and rejects id changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-store-'));
    const store = new ConfigStore(dir);
    store.load();
    expect(store.appExists).toBe(false);
    const text = YAML.stringify(cfg('proj1'));
    store.putProject(text, { create: true });
    expect(store.require('proj1').name).toBe('proj1');
    expect(() => store.putProject(text, { create: true })).toThrow(/уже есть/);
    expect(() => store.putProject(YAML.stringify(cfg('proj2')), { expectId: 'proj1' })).toThrow(/Нельзя менять id/);
    const again = new ConfigStore(dir);
    again.load();
    expect(again.list().map((e) => e.id)).toEqual(['proj1']);
    store.updateApp((doc) => doc.set('proxyPort', 8080));
    again.load();
    expect(again.app.proxyPort).toBe(8080);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('Staging removal (D37)', () => {
  it('moves stages.staging into the staging rules and rewrites the file on load', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-store-'));
    const doc = YAML.parseDocument(YAML.stringify(cfg('proj1')));
    doc.setIn(['stages', 'staging'], { database: 'copy:production', protected: true, tests: { mode: 'changed', failBuild: false } });
    doc.set('branchRules', [
      { match: ['crm', 'pre'], stage: 'staging', overrides: { protected: false, tests: { failBuild: true } } },
      { match: 'backup/*', stage: 'ignore' },
    ]);
    doc.set('hooks', [{ point: 'after:up', action: { type: 'sql', sql: 'select 1' }, stages: ['staging', 'development'] }]);
    fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
    const file = path.join(dir, 'projects', 'proj1.yaml');
    fs.writeFileSync(file, `# my comment
${doc.toString()}`);

    const store = new ConfigStore(dir);
    store.load();
    const c = store.require('proj1');
    expect(c.branchRules[0]).toEqual({
      match: ['crm', 'pre'],
      stage: 'development',
      overrides: { protected: false, tests: { failBuild: true, mode: 'changed' }, database: 'copy:production' },
    });
    expect(c.branchRules[1]).toMatchObject({ stage: 'ignore' });
    expect(c.hooks[0]!.stages).toEqual(['development']);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('# my comment');
    expect(text).not.toContain('staging');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
