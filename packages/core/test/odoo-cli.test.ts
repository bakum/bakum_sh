import { describe, expect, it } from 'vitest';
import { projectConfigSchema } from '@bm/shared';
import { demzPreset, genericPreset, type PresetInputs } from '../src/config/presets';
import { dbSubcommand, dbSubcommandOptions, demoArgs, serverBaseArgs } from '../src/builds/odoo-cli';

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
  network: 'net',
  repoMount: '/mnt/repositories/demz-odoo',
  mounts: [],
  filestoreHostDir: 'E:/fs',
  postgres: { host: 'localhost', port: 5433, internalHost: 'db', user: 'odoo', password: 'x', protectedContainers: [] },
  addonsDirs: ['', 'addons'],
  debugpy: true,
  productionBranch: '19.0',
  odooVersion: '19.0',
};

describe('Odoo CLI arguments', () => {
  it('derives one-off server options from the DEMZ command (no -d / --db-filter / --proxy-mode)', () => {
    const cfg = projectConfigSchema.parse(demzPreset(inputs));
    expect(serverBaseArgs(cfg)).toEqual(['-c', '/etc/odoo/odoo.conf', '--data-dir=/var/lib/odoo']);
    // Odoo 19: no -c before the `db` subcommand; the data dir must still point at the build filestore.
    expect(dbSubcommandOptions(cfg)).toEqual(['-D', '/var/lib/odoo']);
  });

  it('passes addons path and connection options for the Generic preset', () => {
    const cfg = projectConfigSchema.parse(genericPreset({ ...inputs, id: 'gen' }));
    const base = serverBaseArgs(cfg);
    expect(base).toContain('--data-dir=/var/lib/odoo');
    expect(base).toContain('--db_host=db');
    expect(base.find((a) => a.startsWith('--addons-path='))).toBe(
      '--addons-path=/usr/lib/python3/dist-packages/odoo/addons,/mnt/repositories/demz-odoo,/mnt/repositories/demz-odoo/addons',
    );
    expect(dbSubcommandOptions(cfg)).toEqual(expect.arrayContaining(['-D', '/var/lib/odoo', '--db_host=db', '-r', 'odoo']));
  });

  it('runs `odoo db` past the official entrypoint, the password only in the environment (D38)', () => {
    const cfg = projectConfigSchema.parse(genericPreset({ ...inputs, id: 'gen', postgres: { ...inputs.postgres, password: 's3cret' } }));
    const { cmd, env } = dbSubcommand(cfg, ['load', '-f', '-n', 'db1', '/bm-backup/b.zip']);
    expect(cmd.slice(0, 2)).toEqual(['/usr/bin/odoo', 'db']);
    expect(cmd.slice(-5)).toEqual(['load', '-f', '-n', 'db1', '/bm-backup/b.zip']);
    expect(cmd.join(' ')).not.toContain('s3cret');
    expect(env).toEqual({ PGPASSWORD: 's3cret' });
  });

  it('picks demo data options by the Odoo version (D38)', () => {
    const cfg = (odooVersion: string) => projectConfigSchema.parse(genericPreset({ ...inputs, id: 'gen', odooVersion }));
    for (const v of ['16.0', '17.0', '18.0']) {
      expect(demoArgs(cfg(v), true)).toEqual([]);
      expect(demoArgs(cfg(v), false)).toEqual(['--without-demo=all']);
    }
    for (const v of ['19.0', '', 'master']) {
      expect(demoArgs(cfg(v), true)).toEqual(['--with-demo']);
      expect(demoArgs(cfg(v), false)).toEqual([]);
    }
  });
});
