import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectConfigSchema } from '@bm/shared';
import { odooEdition } from '../src/config/edition';
import { genericPreset, odooPreset } from '../src/config/presets';

const repo = { url: 'https://github.com/o/r.git', mirrorDir: 'C:/bm/repos/r.git', localFolder: null };
const pgIn = { host: 'localhost', port: 5432, internalHost: 'db', user: 'odoo', password: '', protectedContainers: [] };

describe('odooEdition', () => {
  const ent = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-ent-'));
  fs.mkdirSync(path.join(ent, 'web_enterprise'));
  fs.writeFileSync(path.join(ent, 'web_enterprise', '__manifest__.py'), "{'name': 'Web Enterprise'}");
  const generic = (mounts: { host: string; container: string; readOnly: boolean }[]) =>
    projectConfigSchema.parse(
      genericPreset({
        id: 'gen', name: 'gen', repo, github: null, remote: 'origin', projectRoot: null, worktreesDir: 'C:/w', moduleRoots: [], modulesToInstall: null,
        image: 'odoo:19', network: 'n', repoMount: '/mnt/r', mounts, filestoreHostDir: 'C:/fs', postgres: pgIn, stackAddons: ['/usr/lib/python3/dist-packages/odoo/addons'], productionBranch: 'main', odooVersion: '19.0',
      }),
    );

  it('finds Enterprise addons in a mount (DEMZ) and says fresh databases stay without web_enterprise', () => {
    const e = odooEdition(generic([{ host: ent, container: '/mnt/enterprise', readOnly: true }]));
    expect(e).toMatchObject({ kind: 'enterprise', source: ent });
    expect(e.note).toMatch(/runtime\.enterprise не задан/);
  });

  it('is Community without such a mount, Enterprise with runtime.enterprise', () => {
    expect(odooEdition(generic([{ host: os.tmpdir(), container: '/mnt/x', readOnly: true }])).kind).toBe('community');
    const odoo = projectConfigSchema.parse(
      odooPreset({
        id: 'shop', name: 'shop', repo, repoName: 'r', github: null, remote: 'origin', worktreesDir: 'C:/w', filestoreHostDir: 'C:/fs', moduleRoots: [],
        modulesToInstall: null, productionBranch: 'main', odooVersion: '19.0', pgPort: 55432, enterpriseDir: 'D:/odoo/enterprise',
      }),
    );
    expect(odooEdition(odoo)).toMatchObject({ kind: 'enterprise', source: 'D:/odoo/enterprise' });
  });
});
