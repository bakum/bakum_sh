import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectConfigSchema, type TestsResult } from '@bm/shared';
import { demzPreset, genericPreset, stackAddons, type PresetInputs } from '../src/config/presets';
import {
  addonsPathVar,
  assertOdooOk,
  codeVars,
  dbSubcommand,
  dbSubcommandOptions,
  demoArgs,
  serverBaseArgs,
  testArgs,
  testsFailed,
  type OneOffResult,
} from '../src/builds/odoo-cli';

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
  stackAddons: ['/usr/lib/python3/dist-packages/odoo/addons'],
  debugpy: true,
  productionBranch: '19.0',
  odooVersion: '19.0',
};

describe('Odoo CLI arguments', () => {
  it('derives one-off server options from the DEMZ command (no -d / --db-filter / --proxy-mode)', () => {
    const cfg = projectConfigSchema.parse(demzPreset(inputs));
    expect(serverBaseArgs(cfg)).toEqual(['-c', '/etc/odoo/odoo.conf', '--data-dir=/var/lib/odoo', '--db_host=db', '--db_port=5432', '--db_user=odoo', '--db_password=']);
    // Odoo 19: no -c before the `db` subcommand; the data dir must still point at the build filestore. The connection
    // comes from the postgres settings, the empty password clears the one of the shared odoo.conf (D54).
    expect(dbSubcommandOptions(cfg)).toEqual(['-D', '/var/lib/odoo', '--db_host=db', '--db_port=5432', '-r', 'odoo', '--db_password=']);
  });

  it('passes addons path and connection options for the Generic preset', () => {
    const cfg = projectConfigSchema.parse(genericPreset({ ...inputs, id: 'gen' }));
    const vars = { addonsPath: '/mnt/repositories/demz-odoo,/mnt/repositories/demz-odoo/addons' };
    const base = serverBaseArgs(cfg, vars);
    expect(base).toContain('--data-dir=/var/lib/odoo');
    expect(base).toContain('--db_host=db');
    expect(base.find((a) => a.startsWith('--addons-path='))).toBe(
      '--addons-path=/usr/lib/python3/dist-packages/odoo/addons,/mnt/repositories/demz-odoo,/mnt/repositories/demz-odoo/addons',
    );
    expect(dbSubcommandOptions(cfg, vars)).toEqual(
      expect.arrayContaining(['-D', '/var/lib/odoo', '--db_host=db', '-r', 'odoo', base.find((a) => a.startsWith('--addons-path='))]),
    );
  });

  it('takes the addons path from the build code, over the shared odoo.conf (D48)', () => {
    const cfg = projectConfigSchema.parse(demzPreset({ ...inputs, moduleRoots: ['demzua', 'exchange'], stackAddons: ['/usr/lib/python3/dist-packages/odoo/addons', '/mnt/enterprise'] }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-code-'));
    for (const f of ['demzua/ai/demz_ai/__manifest__.py', 'demzua/new_domain/demz_new/__manifest__.py', 'exchange/ata_x/__manifest__.py']) {
      fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), '{}');
    }
    const mount = '/mnt/repositories/demz-odoo';
    expect(addonsPathVar(cfg, dir)).toBe(`${mount}/demzua/ai,${mount}/demzua/new_domain,${mount}/exchange`);
    expect(serverBaseArgs(cfg, codeVars(cfg, dir))).toEqual([
      '-c', '/etc/odoo/odoo.conf', '--data-dir=/var/lib/odoo',
      `--addons-path=/usr/lib/python3/dist-packages/odoo/addons,/mnt/enterprise,${mount}/demzua/ai,${mount}/demzua/new_domain,${mount}/exchange`,
      '--db_host=db', '--db_port=5432', '--db_user=odoo', '--db_password=',
    ]);
    // Without the build code the option is left out: the stack's odoo.conf applies.
    expect(serverBaseArgs(cfg)).toEqual(['-c', '/etc/odoo/odoo.conf', '--data-dir=/var/lib/odoo', '--db_host=db', '--db_port=5432', '--db_user=odoo', '--db_password=']);
    fs.rmSync(path.join(dir, 'demzua'), { recursive: true, force: true });
    fs.rmSync(path.join(dir, 'exchange'), { recursive: true, force: true });
    expect(() => addonsPathVar(cfg, dir)).toThrow(/нет модулей Odoo/);
    fs.rmSync(dir, { recursive: true, force: true });
    // A command without {addonsPath} does not scan the code.
    const plain = { ...cfg, runtime: { ...cfg.runtime, command: ['odoo', '-d', '{db}'] } };
    expect(addonsPathVar(plain, 'Z:/no/such/dir')).toBeUndefined();
  });

  it('keeps the stack addons outside the repository (D48)', () => {
    const conf = '/usr/lib/python3/dist-packages/odoo/addons, /mnt/enterprise,/mnt/repositories,/mnt/repositories/demz-odoo/exchange,/mnt/repositories/demz-odoo';
    expect(stackAddons(conf, '/mnt/repositories/demz-odoo')).toEqual(['/usr/lib/python3/dist-packages/odoo/addons', '/mnt/enterprise']);
    expect(stackAddons(null, '/mnt/r')).toEqual(['/usr/lib/python3/dist-packages/odoo/addons']);
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

describe('test runs (spec 8.8)', () => {
  it('builds --test-tags from the per-module template', () => {
    expect(testArgs({ tags: '/{module}', extraArgs: [] }, ['a', 'b'])).toEqual(['--test-enable', '--test-tags', '/a,/b']);
    expect(testArgs({ tags: '', extraArgs: ['--log-level=test'] }, ['a'])).toEqual(['--test-enable', '--test-tags', '/a', '--log-level=test']);
    expect(testArgs({ tags: '-slow/{module}', extraArgs: [] }, ['a'])).toEqual(['--test-enable', '--test-tags', '-slow/a']);
    // Without {module} the template is one tag for all modules.
    expect(testArgs({ tags: 'post_install', extraArgs: [] }, ['a', 'b'])).toEqual(['--test-enable', '--test-tags', 'post_install']);
  });

  const result = (exitCode: number, tests: TestsResult | null, criticals = 0): OneOffResult => ({
    exitCode,
    summary: { errors: 0, criticals, warnings: 0, problems: [], tests },
    tail: [],
  });
  const failing: TestsResult = { passed: 3, failed: 1, errors: 0, warnings: 0, failures: ['FAIL: T.test_x'] };

  it('treats exit code 1 with failed tests as a test result, not a failed run', () => {
    expect(() => assertOdooOk(result(1, failing), 'x')).not.toThrow();
    expect(() => assertOdooOk(result(1, { ...failing, failed: 0 }), 'x')).toThrow(/код 1/);
    expect(() => assertOdooOk(result(1, null), 'x')).toThrow(/код 1/);
    expect(() => assertOdooOk(result(1, failing, 1), 'x')).toThrow(/код 1/);
    expect(testsFailed(failing)).toBe(true);
    expect(testsFailed({ ...failing, failed: 0 })).toBe(false);
    expect(testsFailed(null)).toBe(false);
  });
});
