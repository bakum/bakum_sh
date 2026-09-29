import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { projectConfigSchema } from '@bm/shared';
import { demzPreset } from '../src/config/presets';
import { resolveBranchScope } from '../src/config/effective';
import { dataDirOf, generateCompose, oneOffArgs } from '../src/docker/compose';

const cfg = projectConfigSchema.parse(
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
    mounts: [
      { host: 'E:/demz-odoo-19/repositories', container: '/mnt/repositories', readOnly: true },
      { host: 'E:/demz-odoo-19/enterprise', container: '/mnt/enterprise', readOnly: true },
      { host: 'E:/demz-odoo-19/config/odoo.conf', container: '/etc/odoo/odoo.conf', readOnly: true },
    ],
    filestoreHostDir: 'E:/demz-odoo-19/data/filestore',
    postgres: { host: 'localhost', port: 5433, internalHost: 'db', user: 'odoo', password: 'pa$s', protectedContainers: ['odoo19', 'odoo19-db'] },
    addonsDirs: [],
    productionBranch: '19.0',
    odooVersion: '19.0',
  }),
);

const input = {
  cfg,
  scope: resolveBranchScope(cfg, '19.0-demz-crm', 'development', null).scope,
  branch: { id: 7, name: '19.0-demz-crm', slug: 'crm', stage: 'development' },
  build: { id: 42, number: 3, dbName: 'o19_br_crm_3', host: 'crm.localhost', composeProject: 'bm-demz-crm', debugPort: 5701 },
  worktree: 'E:\\demz-odoo-19\\worktrees\\demz\\crm',
};

describe('generateCompose', () => {
  it('matches the snapshot', () => {
    expect(generateCompose(input)).toMatchSnapshot();
  });

  it('escapes $ for compose interpolation and labels ownership', () => {
    const doc = YAML.parse(generateCompose(input));
    const svc = doc.services.odoo;
    expect(svc.command).toContain('--db-filter=^o19_br_crm_3$$');
    expect(svc.environment.PASSWORD).toBe('pa$$s');
    expect(svc.labels['bm.project']).toBe('demz');
    expect(svc.labels['bm.build']).toBe('42');
    expect(svc.labels['traefik.http.routers.bm-demz-crm.rule']).toBe('Host(`crm.localhost`)');
    expect(svc.ports).toEqual(['127.0.0.1:5701:5678']);
    expect(doc.networks['demz-odoo-19_default']).toEqual({ external: true, name: 'demz-odoo-19_default' });
  });

  it('mounts the worktree at repoMount and the filestore separately, shared folders read-only', () => {
    const svc = YAML.parse(generateCompose(input)).services.odoo;
    expect(svc.volumes).toContainEqual({ type: 'bind', source: 'E:/demz-odoo-19/worktrees/demz/crm', target: '/mnt/repositories/demz-odoo' });
    expect(svc.volumes).toContainEqual({ type: 'bind', source: 'E:/demz-odoo-19/data/filestore', target: '/var/lib/odoo/filestore' });
    expect(svc.volumes.find((v: { target: string }) => v.target === '/mnt/repositories').read_only).toBe(true);
    expect(svc.volumes.some((v: { target: string }) => v.target === '/var/lib/odoo')).toBe(false);
    expect(dataDirOf(cfg)).toBe('/var/lib/odoo');
  });

  it('keeps one-off runs out of Traefik', () => {
    const a = oneOffArgs('C:/x/compose.yml', 'bm-demz-crm', ['E:/b.zip:/bm-backup/b.zip:ro'], ['odoo', '--version']);
    expect(a).toEqual([
      'compose', '-p', 'bm-demz-crm', '-f', 'C:/x/compose.yml', 'run', '--rm', '--no-deps', '-T',
      '-l', 'traefik.enable=false', '-l', 'bm.oneoff=true', '-v', 'E:/b.zip:/bm-backup/b.zip:ro', 'odoo', 'odoo', '--version',
    ]);
    // Variables go by name only: compose reads the values from its own environment.
    expect(oneOffArgs('C:/x/compose.yml', 'p', [], ['odoo'], ['PGPASSWORD']).slice(-4)).toEqual(['-e', 'PGPASSWORD', 'odoo', 'odoo']);
  });
});
