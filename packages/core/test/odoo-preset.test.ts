import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { projectConfigSchema } from '@bm/shared';
import { odooPreset, type OdooPresetInputs } from '../src/config/presets';
import { resolveBranchScope } from '../src/config/effective';
import { managedPgCompose } from '../src/docker/postgres';
import { classifyPushError, classifyRemoteError, withUser } from '../src/git';
import { productionFromBackup } from '../src/builds/request';
import { detectSeries } from '../src/detect';

const inputs: OdooPresetInputs = {
  id: 'shop',
  name: 'shop',
  repo: { url: 'https://github.com/acme/shop.git', mirrorDir: 'C:/Users/u/AppData/Local/Odoo Branch Manager/repos/shop.git', localFolder: null },
  repoName: 'shop',
  github: 'acme/shop',
  remote: 'origin',
  worktreesDir: 'C:/Users/u/AppData/Local/Odoo Branch Manager/worktrees',
  filestoreHostDir: 'C:/Users/u/AppData/Local/Odoo Branch Manager/filestore/shop',
  moduleRoots: ['addons'],
  modulesToInstall: null,
  productionBranch: 'main',
  odooVersion: '18.0',
  pgPort: 55432,
  enterpriseDir: null,
};

describe('«Odoo в Docker» preset (D32)', () => {
  it('is a valid project config with the app’s own Postgres', () => {
    const cfg = projectConfigSchema.parse(odooPreset(inputs));
    expect(cfg.postgres).toMatchObject({ mode: 'managed', host: 'localhost', port: 55432, internalHost: 'db', user: 'odoo' });
    expect(cfg.postgres.protectedContainers).toEqual(['bm-shop-db']);
    expect(cfg.runtime.image).toBe('odoo:18.0');
    expect(cfg.runtime.network).toBe('bm-shop');
    expect(cfg.runtime.enterprise).toBeNull();
    expect(cfg.runtime.command).toContain('--addons-path=/usr/lib/python3/dist-packages/odoo/addons,{addonsPath}');
  });

  it('builds Production fresh with all repository modules, Development fresh with demo', () => {
    const cfg = projectConfigSchema.parse(odooPreset(inputs));
    const prod = resolveBranchScope(cfg, 'main', 'production', null).scope;
    expect(prod).toMatchObject({ database: 'backup', install: 'roots', withDemo: false, folder: null });
    expect(productionFromBackup(cfg, 'production', prod.database)).toBe(false);
    const dev = resolveBranchScope(cfg, 'feature', 'development', null).scope;
    expect(dev).toMatchObject({ database: 'fresh', install: 'roots', withDemo: true, onNewCommit: 'new' });
  });

  it('mounts Enterprise read-only first in the addons path', () => {
    const cfg = projectConfigSchema.parse(odooPreset({ ...inputs, enterpriseDir: 'D:/odoo/enterprise' }));
    expect(cfg.runtime.enterprise).toBe('/mnt/enterprise');
    expect(cfg.runtime.mounts).toEqual([{ host: 'D:/odoo/enterprise', container: '/mnt/enterprise', readOnly: true }]);
    expect(cfg.runtime.command.find((a) => a.startsWith('--addons-path='))).toMatch(/^--addons-path=\/mnt\/enterprise,/);
  });

  it('runs the official image of the chosen series, 16.0 included', () => {
    const cfg = projectConfigSchema.parse(odooPreset({ ...inputs, odooVersion: '16.0' }));
    expect(cfg.runtime.image).toBe('odoo:16.0');
    expect(cfg.runtime.odooVersion).toBe('16.0');
  });
});

describe('productionFromBackup', () => {
  const cfg = projectConfigSchema.parse(odooPreset(inputs));
  const withDir = { ...cfg, production: { ...cfg.production, backups: { ...cfg.production.backups, dir: 'D:/backups' } } };
  it('uses a backup only with a backups folder or an explicit import', () => {
    expect(productionFromBackup(cfg, 'production', 'backup')).toBe(false);
    expect(productionFromBackup(withDir, 'production', 'backup')).toBe(true);
    expect(productionFromBackup(cfg, 'production', 'fresh', 'D:/x.zip')).toBe(true);
    expect(productionFromBackup(withDir, 'production', 'fresh')).toBe(false);
  });
});

describe('managed Postgres compose (D30)', () => {
  it('publishes on loopback, joins the project network under the alias and escapes $', () => {
    const cfg = projectConfigSchema.parse(odooPreset(inputs));
    cfg.postgres.password = 'a$b';
    const text = managedPgCompose(cfg);
    const doc = YAML.parse(text) as { services: { db: Record<string, unknown> }; volumes: Record<string, { name: string }> };
    const db = doc.services.db as { ports: string[]; container_name: string; labels: Record<string, string>; networks: Record<string, { aliases: string[] }> };
    expect(db.ports).toEqual(['127.0.0.1:55432:5432']);
    expect(db.container_name).toBe('bm-shop-db');
    expect(db.labels).toEqual({ 'bm.managed': 'postgres', 'bm.pg-project': 'shop' });
    expect(db.labels['bm.project']).toBeUndefined();
    expect(db.networks['bm-shop']!.aliases).toEqual(['db']);
    expect(doc.volumes.pgdata!.name).toBe('bm-shop-pgdata');
    expect(text).toContain('POSTGRES_PASSWORD: a$$b');
  });
});

describe('git remote errors (D31)', () => {
  it('tells sign-in, denied access, SSH and network apart', () => {
    expect(classifyRemoteError("fatal: could not read Username for 'https://github.com': terminal prompts disabled").problem).toBe('auth');
    expect(classifyRemoteError('remote: Repository not found.\nfatal: repository \'https://github.com/a/b.git/\' not found').problem).toBe('denied');
    expect(classifyRemoteError('git@github.com: Permission denied (publickey).').problem).toBe('ssh-key');
    expect(classifyRemoteError('Host key verification failed.').problem).toBe('host-key');
    expect(classifyRemoteError("fatal: unable to access 'https://x/': Could not resolve host: x").problem).toBe('network');
  });

  it('puts the token user into the clone URL', () => {
    expect(withUser('https://github.com/acme/shop.git', 'x-access-token')).toBe('https://x-access-token@github.com/acme/shop.git');
    expect(withUser('https://old@github.com/acme/shop.git', 'bot')).toBe('https://bot@github.com/acme/shop.git');
  });

  it('tells why a Fork push failed and which account GitHub refused (D57)', () => {
    const denied = classifyPushError(
      "remote: Permission to DEMZ-UA/demz-odoo.git denied to someone.\nfatal: unable to access 'https://github.com/DEMZ-UA/demz-odoo.git/': The requested URL returned error: 403",
    );
    expect(denied).toMatchObject({ problem: 'denied', account: 'someone' });
    expect(denied.message).toContain('«someone»');
    expect(classifyPushError('remote: Write access to repository not granted.\nfatal: ... error: 403')).toMatchObject({ problem: 'denied', account: null });
    expect(classifyPushError('ERROR: Permission to acme/shop.git denied to deploy key')).toMatchObject({ problem: 'denied', account: null });
    expect(
      classifyPushError(
        'remote: error: GH013: Repository rule violations found for refs/heads/x.\n! [remote rejected] abc -> x (push declined due to repository rule violations)',
      ).problem,
    ).toBe('rules');
    expect(classifyPushError('To https://github.com/a/b.git\n!\trefs/heads/x\t[rejected] (stale info)\nDone').problem).toBe('exists');
    expect(classifyPushError("fatal: could not read Username for 'https://github.com': terminal prompts disabled").problem).toBe('auth');
    expect(classifyPushError("fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com").problem).toBe('network');
  });
});

describe('detectSeries', () => {
  it('takes the most frequent manifest series, else a series-named production branch', () => {
    const manifests = ['17.0', '17.0', '18.0'].map((v, i) => `{'name': 'm${i}', 'version': '${v}.1.0.0'}`);
    expect(detectSeries([...manifests, null], null)).toBe('17.0');
    expect(detectSeries([], '18.0')).toBe('18.0');
    expect(detectSeries([], 'main')).toBeNull();
    expect(detectSeries(["{'version': '16.0.1.0.0'}", "{'version': '16.0.2.1.0'}"], 'main')).toBe('16.0');
  });
});
