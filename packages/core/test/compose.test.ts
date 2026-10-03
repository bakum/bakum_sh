import { describe, expect, it } from 'vitest';
import path from 'node:path';
import YAML from 'yaml';
import { projectConfigSchema } from '@bm/shared';
import { demzPreset } from '../src/config/presets';
import { resolveBranchScope } from '../src/config/effective';
import { dataDirOf, generateCompose, ONEOFF_OVERRIDE, oneOffArgs, oneOffOverridePath } from '../src/docker/compose';
import { parseComposeTemplate } from '../src/config/compose-template';

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
    stackAddons: ['/usr/lib/python3/dist-packages/odoo/addons'],
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
  addonsPath: '/mnt/repositories/demz-odoo/demzua/perevertum/crm,/mnt/repositories/demz-odoo/exchange',
  proxyPort: 8080,
  odooArgs: ['-c', '/etc/odoo/odoo.conf', '--data-dir=/var/lib/odoo', '--addons-path=/mnt/repositories/demz-odoo/exchange'],
};

describe('generateCompose', () => {
  it('matches the snapshot', () => {
    expect(generateCompose(input)).toMatchSnapshot();
  });

  it('escapes $ for compose interpolation and labels ownership', () => {
    const doc = YAML.parse(generateCompose(input));
    const svc = doc.services.odoo;
    expect(svc.command).toContain('--db-filter=^o19_br_crm_3$$');
    expect(svc.command).toContain(
      '--addons-path=/usr/lib/python3/dist-packages/odoo/addons,/mnt/repositories/demz-odoo/demzua/perevertum/crm,/mnt/repositories/demz-odoo/exchange',
    );
    expect(svc.environment.PASSWORD).toBe('pa$$s');
    expect(svc.labels['bm.project']).toBe('demz');
    expect(svc.labels['bm.build']).toBe('42');
    expect(svc.labels['traefik.http.routers.bm-demz-crm.rule']).toBe('Host(`crm.localhost`)');
    expect(svc.ports).toEqual(['127.0.0.1:5701:5678']);
    // Context labels for the assistant skill (D52).
    expect(svc.labels['bm.slug']).toBe('crm');
    expect(svc.labels['bm.url']).toBe('http://crm.localhost:8080');
    expect(svc.labels['bm.protected']).toBe('true'); // 19.0-demz-crm is in repo.protectedBranches of the preset
    expect(svc.labels['bm.odoo.args']).toBe('-c /etc/odoo/odoo.conf --data-dir=/var/lib/odoo --addons-path=/mnt/repositories/demz-odoo/exchange');
    const dev = YAML.parse(generateCompose({ ...input, branch: { ...input.branch, name: '19.0-demz-perevertum', slug: 'perevertum' }, proxyPort: 80, odooArgs: undefined }));
    expect(dev.services.odoo.labels['bm.protected']).toBe('false');
    expect(dev.services.odoo.labels['bm.url']).toBe('http://crm.localhost');
    expect(dev.services.odoo.labels['bm.odoo.args']).toBeUndefined();
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
      'compose', '-p', 'bm-demz-crm', '-f', 'C:/x/compose.yml', '-f', oneOffOverridePath('C:/x/compose.yml'), 'run', '--rm', '--no-deps', '-T',
      '-l', 'traefik.enable=false', '-l', 'bm.oneoff=true', '-v', 'E:/b.zip:/bm-backup/b.zip:ro', 'odoo', 'odoo', '--version',
    ]);
    // Variables go by name only: compose reads the values from its own environment.
    expect(oneOffArgs('C:/x/compose.yml', 'p', [], ['odoo'], ['PGPASSWORD']).slice(-4)).toEqual(['-e', 'PGPASSWORD', 'odoo', 'odoo']);
  });

  it('runs one-offs without the service healthcheck (D60)', () => {
    expect(path.basename(oneOffOverridePath('C:/x/compose.yml'))).toBe('compose.oneoff.yml');
    expect(YAML.parse(ONEOFF_OVERRIDE)).toEqual({ services: { odoo: { healthcheck: { disable: true } } } });
  });
});

describe('runtime.composeTemplate (D72)', () => {
  const tpl = parseComposeTemplate(
    [
      'x-common: &common',
      '  restart: "no"',
      'services:',
      '  odoo:',
      '    environment: [REDIS_URL=redis://redis:6379/0, PGPASSWORD=override]',
      '    labels: { team: odoo, bm.project: other, traefik.enable: "false" }',
      '    volumes: [{ type: volume, source: cache, target: /cache }]',
      '    mem_limit: 4g',
      '    depends_on: [redis]',
      '  redis:',
      '    <<: *common',
      '    image: redis:7',
      '    command: [redis-server, --dbfilename, "{db}.rdb"]',
      '    volumes: [cache:/data]',
      '  mailpit:',
      '    image: axllent/mailpit',
      '    labels: [traefik.enable=true, bm.build=1]',
      '    networks: { mail: {} }',
      'volumes:',
      '  cache: {}',
      'networks:',
      '  mail: {}',
    ].join('\n'),
    'tpl.yml',
  );
  const doc = YAML.parse(generateCompose({ ...input, template: tpl }));

  it('merges services.odoo into the build service; the app keeps its labels and network', () => {
    const svc = doc.services.odoo;
    expect(svc.environment.REDIS_URL).toBe('redis://redis:6379/0');
    expect(svc.environment.PGPASSWORD).toBe('override');
    expect(svc.labels.team).toBe('odoo');
    expect(svc.labels['bm.project']).toBe('demz');
    expect(svc.labels['traefik.enable']).toBe('true');
    expect(svc.volumes).toContainEqual({ type: 'bind', source: 'E:/demz-odoo-19/worktrees/demz/crm', target: '/mnt/repositories/demz-odoo' });
    expect(svc.volumes).toContainEqual({ type: 'volume', source: 'cache', target: '/cache' });
    expect(svc.mem_limit).toBe('4g');
    expect(svc.depends_on).toEqual(['redis']);
    expect(svc.networks).toEqual(['demz-odoo-19_default']);
    expect(svc.command).toContain('--db-filter=^o19_br_crm_3$$');
  });

  it('adds other services with ownership labels, the project network and no Traefik route by default', () => {
    const redis = doc.services.redis;
    expect(redis.command).toEqual(['redis-server', '--dbfilename', 'o19_br_crm_3.rdb']);
    expect(redis.restart).toBe('no');
    expect(redis.networks).toEqual(['demz-odoo-19_default']);
    expect(redis.labels).toEqual({
      'traefik.enable': 'false',
      'bm.project': 'demz',
      'bm.branch': '7',
      'bm.build': '42',
      'bm.build.number': '3',
      'bm.service': 'redis',
    });
    const mail = doc.services.mailpit;
    expect(mail.restart).toBe('unless-stopped');
    expect(mail.labels['traefik.enable']).toBe('true');
    expect(mail.labels['bm.build']).toBe('42');
    expect(mail.networks).toEqual({ 'demz-odoo-19_default': {}, mail: {} });
    expect(doc.volumes).toEqual({ cache: {} });
    expect(doc.networks).toEqual({ mail: {}, 'demz-odoo-19_default': { external: true, name: 'demz-odoo-19_default' } });
    expect(doc.name).toBe('bm-demz-crm');
    expect(doc['x-common']).toBeUndefined();
  });

  it('rejects what would break builds', () => {
    expect(() => parseComposeTemplate('name: x', 'f')).toThrow(/name/);
    expect(() => parseComposeTemplate('services:\n  odoo:\n    container_name: odoo', 'f')).toThrow(/container_name/);
    expect(() => parseComposeTemplate('services:\n  Bad Name: {}', 'f')).toThrow(/Bad Name/);
    expect(() => parseComposeTemplate('services: [a]', 'f')).toThrow();
    expect(() => parseComposeTemplate(':\n -', 'f')).toThrow();
    expect(parseComposeTemplate('', 'f')).toEqual({ services: {}, volumes: {}, networks: {} });
  });

  it('leaves the generated file unchanged without a template', () => {
    expect(generateCompose({ ...input, template: null })).toBe(generateCompose(input));
  });
});
