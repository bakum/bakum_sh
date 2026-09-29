import { describe, expect, it } from 'vitest';
import { projectConfigSchema } from '@bm/shared';
import { demzPreset, genericPreset, type PresetInputs } from '../src/config/presets';

const inputs: PresetInputs = {
  id: 'demz',
  name: 'x',
  repo: { url: 'https://github.com/o/r.git', mirrorDir: 'C:/bm/repos/r.git', localFolder: null },
  github: null,
  remote: 'origin',
  projectRoot: 'E:/demz-odoo-19',
  worktreesDir: 'E:/w',
  moduleRoots: [],
  modulesToInstall: null,
  image: 'img',
  network: 'demz-odoo-19_default',
  repoMount: '/mnt/repositories/demz-odoo',
  mounts: [],
  filestoreHostDir: 'E:/fs',
  postgres: { host: 'localhost', port: 5433, internalHost: 'db', user: 'odoo', password: '', protectedContainers: ['odoo19', 'odoo19-db'] },
  stackAddons: ['/usr/lib/python3/dist-packages/odoo/addons'],
  productionBranch: '19.0',
  odooVersion: '19.0',
};

describe('Postgres of the DEMZ / Generic presets', () => {
  it.each([
    ['DEMZ', demzPreset],
    ['Generic', genericPreset],
  ])('%s: the app\'s own Postgres in its own network when managedPg is given (new projects)', (_, preset) => {
    const cfg = projectConfigSchema.parse(preset({ ...inputs, managedPg: { image: 'pgvector/pgvector:pg16', port: 55433 } }));
    expect(cfg.postgres).toMatchObject({ mode: 'managed', image: 'pgvector/pgvector:pg16', host: 'localhost', port: 55433, internalHost: 'db', user: 'odoo' });
    expect(cfg.postgres.protectedContainers).toEqual(['odoo19', 'odoo19-db', 'bm-demz-db']);
    expect(cfg.runtime.network).toBe('bm-demz');
  });

  it.each([
    ['DEMZ', demzPreset],
    ['Generic', genericPreset],
  ])('%s: the detected Postgres and the stack network without managedPg', (_, preset) => {
    const cfg = projectConfigSchema.parse(preset(inputs));
    expect(cfg.postgres).toMatchObject({ mode: 'external', port: 5433, protectedContainers: ['odoo19', 'odoo19-db'] });
    expect(cfg.runtime.network).toBe('demz-odoo-19_default');
  });
});
