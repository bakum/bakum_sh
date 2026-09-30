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
import { assertBranchFolder, assertFolderOnBranch, DETACHED, FOLDER_SAFE_JOBS, folderBranchMismatch } from '../src/git/worktrees';
import { deletePreview, requestDelete } from '../src/services/branch-delete';
import { LocalWatcher } from '../src/services/watch-local';
import { setQueue, type JobQueue } from '../src/jobs/queue';
import { requestBuildChecked } from '../src/builds/request';
import type { Ctx } from '../src/context';

// D59: a build from the user's folder is blocked while another branch is open there.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-folder-branch-'));
afterAll(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* Windows: read-only git objects in a temp folder, left for the OS */
  }
});

const posix = (p: string) => p.replace(/\\/g, '/');
const work = posix(path.join(tmp, 'work'));

async function sh(cwd: string, ...args: string[]): Promise<string> {
  const r = await execa('git', args, { cwd, env: { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
  return r.stdout.trim();
}

async function commit(file: string): Promise<string> {
  fs.writeFileSync(path.join(work, file), file);
  await sh(work, 'add', '.');
  await sh(work, 'commit', '-m', file);
  return sh(work, 'rev-parse', 'HEAD');
}

let featSha = '';
beforeAll(async () => {
  await sh(tmp, 'init', '-b', 'main', work);
  await sh(work, 'config', 'user.email', 't@t');
  await sh(work, 'config', 'user.name', 't');
  await commit('a.txt');
  await sh(work, 'checkout', '-b', 'feat');
  featSha = await commit('b.txt');
});

describe('folderBranchMismatch / assertFolderOnBranch', () => {
  it('reports the branch open in the folder when it is not the branch of the build', async () => {
    await sh(work, 'checkout', 'feat');
    expect(await folderBranchMismatch(work, 'feat')).toBeNull();
    expect(await folderBranchMismatch(work, 'main')).toBe('feat');
    await expect(assertFolderOnBranch({ name: 'feat' }, { folder: work })).resolves.toBeUndefined();
    await expect(assertFolderOnBranch({ name: 'main' }, { folder: work })).rejects.toMatchObject({ code: 'FOLDER_WRONG_BRANCH' });
    // Code from the mirror: nothing to check.
    await expect(assertFolderOnBranch({ name: 'main' }, { folder: null })).resolves.toBeUndefined();
  });

  it('treats a detached HEAD (rebase, checkout of a commit) as another branch', async () => {
    await sh(work, 'checkout', '--detach', featSha);
    expect(await folderBranchMismatch(work, 'feat')).toBe(DETACHED);
    await sh(work, 'checkout', 'feat');
  });
});

describe('builds of a folder branch while another branch is open (D59)', () => {
  const root = path.join(tmp, 'app');
  const dataDir = path.join(root, 'data');
  const logsDir = path.join(dataDir, 'logs');
  const configDir = path.join(root, 'config');
  let ctx: Ctx;
  let branchId = 0;
  const enqueued: string[] = [];

  beforeAll(() => {
    fs.mkdirSync(configDir, { recursive: true });
    const store = new ConfigStore(configDir);
    store.load();
    const inputs: PresetInputs = {
      id: 'shop',
      name: 'shop',
      repo: { url: 'https://github.com/acme/shop.git', mirrorDir: posix(path.join(dataDir, 'repos', 'shop.git')), localFolder: work },
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
    const { db, sqlite } = openDb(path.join(root, 'registry.sqlite'));
    ctx = { store, db, sqlite, dataDir, logsDir, configDir, toMain: () => {}, proxyPort: null } as unknown as Ctx;
    const now = new Date().toISOString();
    const br = db
      .insert(branches)
      .values({ projectId: 'shop', name: 'feat', slug: 'feat', stage: 'development', assignedBy: 'user', overrides: { folder: work }, createdAt: now, lastSeenLocalSha: featSha })
      .returning()
      .get();
    branchId = br.id;
    db.insert(builds)
      .values({
        branchId,
        projectId: 'shop',
        number: 1,
        stage: 'development',
        commitSha: featSha,
        trigger: 'manual',
        kind: 'new',
        dbSource: 'fresh',
        dbName: 'shop_feat',
        host: 'feat.localhost',
        composeProject: 'bm-shop-feat',
        status: 'running',
        live: true,
        createdAt: now,
      })
      .run();
    setQueue({ enqueue: (type: string) => (enqueued.push(type), enqueued.length) } as unknown as JobQueue);
  });
  afterAll(() => (ctx as unknown as { sqlite: { close(): void } }).sqlite.close());

  const branch = () => ctx.db.select().from(branches).where(eq(branches.id, branchId)).get()!;

  it('a commit in another branch of the folder triggers nothing and is not remembered', async () => {
    const w = new LocalWatcher(ctx);
    await sh(work, 'checkout', 'main');
    await commit('c.txt');
    await w.check(branchId);
    expect(w.folderBranch(branchId)).toBe('main');
    expect(enqueued).toEqual([]);
    expect(branch().lastSeenLocalSha).toBe(featSha);
  });

  it('manual actions are refused before any job is queued', async () => {
    await expect(requestBuildChecked(ctx, branchId, { trigger: 'rebuild', kind: 'new' })).rejects.toMatchObject({ code: 'FOLDER_WRONG_BRANCH' });
    await expect(assertBranchFolder(ctx, branchId)).rejects.toThrow(/открыта ветка main, а сборка — ветки feat/);
    // Drop and Delete of the branch (which drops its builds) are refused too; only Stop runs.
    await expect(assertBranchFolder(ctx, branchId, { usable: false })).rejects.toMatchObject({ code: 'FOLDER_WRONG_BRANCH' });
    expect((await deletePreview(ctx, branchId)).folderBlocked).toMatch(/открыта ветка main/);
    await expect(requestDelete(ctx, { branchId, confirmSlug: 'feat', deleteRemote: false, forceDirty: false })).rejects.toMatchObject({ code: 'FOLDER_WRONG_BRANCH' });
    expect([...FOLDER_SAFE_JOBS]).toEqual(['stop']);
    expect(enqueued).toEqual([]);
  });

  it('back on the branch: the block lifts itself, a new commit of the branch updates the build', async () => {
    const w = new LocalWatcher(ctx);
    await sh(work, 'checkout', 'feat');
    await w.check(branchId);
    expect(w.folderBranch(branchId)).toBe('feat');
    expect(enqueued).toEqual([]);
    await expect(assertBranchFolder(ctx, branchId)).resolves.toBeUndefined();
    const sha = await commit('d.txt');
    await w.check(branchId);
    expect(branch().lastSeenLocalSha).toBe(sha);
    expect(enqueued).toEqual(['build']);
  });
});
