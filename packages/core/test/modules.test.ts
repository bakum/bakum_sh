import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addonsDirsFrom,
  changedModules,
  manifestVersion,
  matchInstalled,
  moduleOfFile,
  moduleRootsFrom,
  modulesFromTree,
  parseModuleList,
  scanModules,
  splitInstallUpdate,
} from '../src/modules';

const tree = [
  'README.md',
  'demzua/modules_to_install.txt',
  'demzua/accounting/demz_nbu_currency_rate/__manifest__.py',
  'demzua/accounting/demz_nbu_currency_rate/models/rate.py',
  'demzua/perevertum/crm/demz_crm_lead/__manifest__.py',
  'demzua/perevertum/crm/demz_crm_lead/views/lead.xml',
  'todoltd/stock/td_demz_stock/__manifest__.py',
  'todoltd/stock/td_demz_stock/data/x.xml',
  'exchange/ata_exchange_v4/__manifest__.py',
  'tools/helper/__manifest__.py',
];
const mods = modulesFromTree(tree);
const roots = ['demzua', 'todoltd', 'exchange'];

describe('module detection (spec 8.7)', () => {
  it('finds modules and roots from a git tree', () => {
    expect(mods.map((m) => m.name).sort()).toEqual(['ata_exchange_v4', 'demz_crm_lead', 'demz_nbu_currency_rate', 'helper', 'td_demz_stock']);
    expect(moduleRootsFrom(mods)).toEqual(['demzua', 'exchange', 'todoltd', 'tools']);
    expect(addonsDirsFrom(mods)).toContain('demzua/perevertum/crm');
  });

  it('maps a file to the nearest module inside moduleRoots', () => {
    const map = new Map(mods.map((m) => [m.dir, m]));
    expect(moduleOfFile('demzua/perevertum/crm/demz_crm_lead/views/lead.xml', map, roots)?.name).toBe('demz_crm_lead');
    expect(moduleOfFile('demzua/modules_to_install.txt', map, roots)).toBeNull();
    expect(moduleOfFile('tools/helper/x.py', map, roots)).toBeNull();
    expect(moduleOfFile('tools/helper/x.py', map, [])?.name).toBe('helper');
  });

  it('collects changed and removed modules from a diff', () => {
    const before = [...mods, { name: 'demz_old', dir: 'demzua/old/demz_old' }];
    const r = changedModules(
      ['demzua/accounting/demz_nbu_currency_rate/models/rate.py', 'todoltd/stock/td_demz_stock/data/x.xml', 'demzua/old/demz_old/__init__.py', 'README.md'],
      mods,
      before,
      roots,
    );
    expect(r.changed.map((m) => m.name).sort()).toEqual(['demz_nbu_currency_rate', 'td_demz_stock']);
    expect(r.removed.map((m) => m.name)).toEqual(['demz_old']);
  });

  it('splits into -u (installed), -i (wanted, not installed) and nothing', () => {
    const r = splitInstallUpdate(['demz_crm_lead', 'td_demz_stock', 'helper', 'demz_crm_lead'], new Set(['td_demz_stock']), new Set(['demz_crm_lead']));
    expect(r).toEqual({ update: ['td_demz_stock'], install: ['demz_crm_lead'], none: ['helper'] });
  });

  it('parses the modules list file and installedMatching globs', () => {
    expect(parseModuleList('# my modules\ndemz_a\n demz_b , demz_c\n\nBad-Name\n')).toEqual(['demz_a', 'demz_b', 'demz_c']);
    expect(matchInstalled(['td_x', 'ata_y', 'demz_z', 'sale', 'account'], ['td_*', 'ata_*', 'demz_*'])).toEqual(['ata_y', 'demz_z', 'td_x']);
  });

  it('reads manifest versions', () => {
    expect(manifestVersion("{'name': 'X', 'version': '19.0.1.2.0', 'depends': []}")).toBe('19.0.1.2.0');
    expect(manifestVersion(null)).toBeNull();
  });

  it('scans the filesystem up to depth 4', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-mods-'));
    for (const f of ['a/b/c/m4/__manifest__.py', 'a/m2/__manifest__.py', 'a/b/c/d/m5/__manifest__.py', '.git/x/__manifest__.py']) {
      fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), '{}');
    }
    expect(scanModules(dir, 4).map((m) => m.dir)).toEqual(['a/b/c/m4', 'a/m2']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
