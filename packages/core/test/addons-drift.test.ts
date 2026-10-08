import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { genericPreset, type PresetInputs } from '../src/config/presets';
import { ConfigStore } from '../src/config/store';
import { openDb } from '../src/db';
import { branches, builds } from '../src/db/schema';
import { writeLiveCompose } from '../src/builds/executors';
import { addonsDrift } from '../src/builds/live-compose';
import { branchView } from '../src/services/branches';
import { t } from '../src/i18n';
import type { Ctx } from '../src/context';

// D77: a build from the user's folder notices module folders added after its container was created.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-addons-drift-'));
afterAll(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* Windows: read-only git objects in a temp folder, left for the OS */
  }
});

const posix = (p: string) => p.replace(/\\/g, '/');
const work = posix(path.join(tmp, 'work'));
const root = posix(path.join(tmp, 'app'));

const addModule = (dir: string) => {
  fs.mkdirSync(path.join(work, dir), { recursive: true });
  fs.writeFileSync(path.join(work, dir, '__manifest__.py'), '{}');
};

let ctx: Ctx;
let branchId = 0;
const log = () => {};

const branch = () => ctx.db.select().from(branches).where(eq(branches.id, branchId)).get()!;
const live = () => ctx.db.select().from(builds).where(eq(builds.branchId, branchId)).get()!;
const badges = () => branchView(ctx, ctx.store.require('shop'), branch()).badges;
const setOverrides = (overrides: Record<string, unknown>) => ctx.db.update(branches).set({ overrides }).where(eq(branches.id, branchId)).run();

beforeAll(async () => {
  await execa('git', ['init', '-b', 'main', work], { cwd: tmp });
  addModule('addons/demo');
  const configDir = path.join(root, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const store = new ConfigStore(configDir);
  store.load();
  const inputs: PresetInputs = {
    id: 'shop',
    name: 'shop',
    repo: { url: 'https://github.com/acme/shop.git', mirrorDir: posix(path.join(root, 'repos', 'shop.git')), localFolder: work },
    github: 'acme/shop',
    remote: 'origin',
    projectRoot: null,
    worktreesDir: posix(path.join(root, 'worktrees')),
    moduleRoots: [],
    modulesToInstall: null,
    image: 'odoo:19',
    network: 'n',
    repoMount: '/mnt/repo/shop',
    mounts: [],
    filestoreHostDir: posix(path.join(root, 'filestore')),
    postgres: { host: 'localhost', port: 5432, internalHost: 'db', user: 'odoo', password: '', protectedContainers: [] },
    stackAddons: ['/usr/lib/python3/dist-packages/odoo/addons'],
    productionBranch: 'main',
    odooVersion: '19.0',
  };
  store.putProject(YAML.stringify(genericPreset(inputs)), { create: true });
  const dataDir = path.join(root, 'data');
  const { db, sqlite } = openDb(path.join(root, 'registry.sqlite'));
  ctx = { store, db, sqlite, dataDir, logsDir: path.join(dataDir, 'logs'), configDir, toMain: () => {}, proxyPort: null } as unknown as Ctx;
  const now = new Date().toISOString();
  branchId = db.insert(branches).values({ projectId: 'shop', name: 'feat', slug: 'feat', stage: 'development', assignedBy: 'user', overrides: { folder: work }, createdAt: now }).returning().get().id;
  db.insert(builds)
    .values({
      branchId,
      projectId: 'shop',
      number: 1,
      stage: 'development',
      trigger: 'new_commit',
      kind: 'update',
      dbSource: 'fresh',
      dbName: 'shop_feat',
      host: 'feat.localhost',
      composeProject: 'bm-shop-feat',
      status: 'running',
      live: true,
      createdAt: now,
    })
    .run();
  const hash = await writeLiveCompose(ctx, live(), log);
  db.update(builds).set({ configHash: hash }).where(eq(builds.branchId, branchId)).run();
});
afterAll(() => (ctx as unknown as { sqlite: { close(): void } }).sqlite.close());

describe('module folders of a folder build (D77)', () => {
  it('the same folders: no drift, no badge', () => {
    expect(addonsDrift(ctx, live())).toBeNull();
    expect(badges().map((x) => x.kind)).not.toContain('config-changed');
  });

  it('a new module root: drift with the new --addons-path and the «Применить» badge', () => {
    addModule('terminal/term_base');
    const drift = addonsDrift(ctx, live());
    expect(drift?.text).toContain('/mnt/repo/shop/terminal');
    expect(fs.readFileSync(drift!.file, 'utf8')).not.toContain('/mnt/repo/shop/terminal');
    expect(badges()).toContainEqual({ kind: 'config-changed', text: t('badge.addonsChanged') });
  });

  it('a module in a known folder changes nothing', () => {
    addModule('addons/demo2');
    expect(addonsDrift(ctx, live())?.text).toContain('/mnt/repo/shop/terminal');
    fs.rmSync(path.join(work, 'addons', 'demo2'), { recursive: true });
  });

  it('a changed configuration shows only its own badge', () => {
    const hash = live().configHash;
    ctx.db.update(builds).set({ configHash: 'other' }).where(eq(builds.branchId, branchId)).run();
    expect(addonsDrift(ctx, live())).toBeNull();
    expect(badges().filter((x) => x.kind === 'config-changed').map((x) => x.text)).toEqual([t('badge.configChanged')]);
    ctx.db.update(builds).set({ configHash: hash }).where(eq(builds.branchId, branchId)).run();
  });

  it('code from the mirror is not checked', () => {
    setOverrides({});
    expect(addonsDrift(ctx, live())).toBeNull();
    setOverrides({ folder: work });
  });

  it('the rewritten compose.yml ends the drift', async () => {
    await writeLiveCompose(ctx, live(), log);
    expect(fs.readFileSync(path.join(ctx.dataDir, 'projects', 'shop', 'branches', 'feat', 'compose.yml'), 'utf8')).toContain('/mnt/repo/shop/terminal');
    expect(addonsDrift(ctx, live())).toBeNull();
    expect(badges().map((x) => x.kind)).not.toContain('config-changed');
  });
});
