import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { genericPreset, type PresetInputs } from '../src/config/presets';
import { ConfigStore } from '../src/config/store';
import { resolveBranchScope } from '../src/config/effective';
import { openDb } from '../src/db';
import { branches, builds } from '../src/db/schema';
import * as git from '../src/git';
import { ensureWorktree, syncWorktreeTo, worktreeHeadSync } from '../src/git/worktrees';
import { configHash } from '../src/builds/view';
import { writeLiveCompose } from '../src/builds/executors';
import { branchView } from '../src/services/branches';
import type { Ctx } from '../src/context';

// D64: the worktree a live build runs is put on the build's commit; after building from the user's folder it is not.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-worktree-sync-'));
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
const mirror = posix(path.join(root, 'repos', 'shop.git'));

async function sh(cwd: string, ...args: string[]): Promise<string> {
  const r = await execa('git', args, { cwd, env: { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
  return r.stdout.trim();
}

async function commit(file: string): Promise<string> {
  fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
  fs.writeFileSync(path.join(work, file), file);
  await sh(work, 'add', '.');
  await sh(work, 'commit', '-m', file);
  return sh(work, 'rev-parse', 'HEAD');
}

let ctx: Ctx;
let branchId = 0;
let oldSha = '';
let buildSha = '';
const lines: string[] = [];
const log = (l: string) => lines.push(l);

const branch = () => ctx.db.select().from(branches).where(eq(branches.id, branchId)).get()!;
const live = () => ctx.db.select().from(builds).where(eq(builds.branchId, branchId)).get()!;
const badges = () => branchView(ctx, ctx.store.require('shop'), branch()).badges.map((x) => x.kind);

beforeAll(async () => {
  await sh(tmp, 'init', '-b', 'main', work);
  await sh(work, 'config', 'user.email', 't@t');
  await sh(work, 'config', 'user.name', 't');
  await commit('a.txt');
  await sh(work, 'checkout', '-b', 'feat');
  oldSha = await commit('b.txt');
  // Like on DEMZ: the module of the branch only exists from the build commit on.
  buildSha = await commit('addons/demo/__manifest__.py');
  await git.initMirror(work, mirror, { onLine: () => {} });

  const configDir = path.join(root, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const store = new ConfigStore(configDir);
  store.load();
  const inputs: PresetInputs = {
    id: 'shop',
    name: 'shop',
    repo: { url: 'https://github.com/acme/shop.git', mirrorDir: mirror, localFolder: work },
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
  // The branch was built from the user's folder (build #2 on buildSha); the app's worktree stayed on an older commit.
  branchId = db.insert(branches).values({ projectId: 'shop', name: 'feat', slug: 'feat', stage: 'development', assignedBy: 'user', overrides: { folder: work }, createdAt: now }).returning().get().id;
  const wt = await ensureWorktree(ctx, store.require('shop'), branch());
  await git.checkoutDetach(wt, oldSha);
  db.insert(builds)
    .values({
      branchId,
      projectId: 'shop',
      number: 2,
      stage: 'development',
      commitSha: buildSha,
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
});
afterAll(() => (ctx as unknown as { sqlite: { close(): void } }).sqlite.close());

describe('worktree on the commit of the live build (D64)', () => {
  it('reads HEAD of the worktree without git', () => {
    expect(worktreeHeadSync(branch().worktreePath!)).toBe(oldSha);
    expect(worktreeHeadSync(work)).toBeNull();
  });

  it('switched off the folder: «Применить» puts the worktree on the build commit before the compose file', async () => {
    ctx.db.update(branches).set({ overrides: {} }).where(eq(branches.id, branchId)).run();
    const hash = await writeLiveCompose(ctx, live(), log);
    expect(await git.headSha(branch().worktreePath!)).toBe(buildSha);
    expect(lines.join('\n')).toContain(`git checkout --detach ${buildSha.slice(0, 7)}`);
    const cfg = ctx.store.require('shop');
    expect(hash).toBe(configHash(cfg, resolveBranchScope(cfg, 'feat', 'development', {}).scope, ctx.store.app.proxyPort));
  });

  it('the branch page warns while the worktree is on another commit', async () => {
    const cfg = ctx.store.require('shop');
    ctx.db.update(builds).set({ configHash: configHash(cfg, resolveBranchScope(cfg, 'feat', 'development', {}).scope, ctx.store.app.proxyPort) }).where(eq(builds.branchId, branchId)).run();
    expect(badges()).not.toContain('worktree-off-build');
    await git.checkoutDetach(branch().worktreePath!, oldSha);
    expect(badges()).toContain('worktree-off-build');
    // A changed configuration already asks for «Применить», which syncs the worktree itself.
    ctx.db.update(builds).set({ configHash: 'other' }).where(eq(builds.branchId, branchId)).run();
    expect(badges()).not.toContain('worktree-off-build');
  });

  it('edits in the worktree are not overwritten', async () => {
    const wt = branch().worktreePath!;
    fs.writeFileSync(path.join(wt, 'b.txt'), 'edited');
    await expect(syncWorktreeTo(ctx, ctx.store.require('shop'), branch(), buildSha, log)).rejects.toMatchObject({ code: 'WORKTREE_DIRTY' });
    expect(await git.headSha(wt)).toBe(oldSha);
    await sh(wt, 'checkout', '--', 'b.txt');
  });

  it('a commit that never reached the mirror (unpushed in the folder) is refused', async () => {
    const local = await commit('d.txt');
    await expect(syncWorktreeTo(ctx, ctx.store.require('shop'), branch(), local, log)).rejects.toMatchObject({ code: 'NO_BUILD_COMMIT' });
    expect(await git.headSha(branch().worktreePath!)).toBe(oldSha);
  });

  it('a missing worktree is recreated on the build commit', async () => {
    const cfg = ctx.store.require('shop');
    await git.worktreeRemove(mirror, branch().worktreePath!, true);
    const wt = await syncWorktreeTo(ctx, cfg, branch(), buildSha, log);
    expect(await git.headSha(wt)).toBe(buildSha);
    expect(badges()).not.toContain('worktree-off-build');
  });
});
