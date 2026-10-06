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
import { auditLog, branches, builds } from '../src/db/schema';
import { LocalWatcher } from '../src/services/watch-local';
import { setQueue, type JobQueue } from '../src/jobs/queue';
import {
  afterModules,
  alreadyApplied,
  codeFingerprint,
  codeStateOf,
  commitCodeState,
  folderCodeState,
  forgetModules,
  sameCode,
  testsCover,
} from '../src/builds/code-state';
import type { Ctx } from '../src/context';

// D76: a commit of code the live build of a folder branch already got (manual -u) and tested rebuilds nothing.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-same-code-'));
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

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
  fs.writeFileSync(path.join(work, file), text);
}

async function commitAll(msg: string): Promise<string> {
  await sh(work, 'add', '-A');
  await sh(work, 'commit', '-m', msg);
  return sh(work, 'rev-parse', 'HEAD');
}

let sha0 = '';
beforeAll(async () => {
  await sh(tmp, 'init', '-b', 'feat', work);
  await sh(work, 'config', 'user.email', 't@t');
  await sh(work, 'config', 'user.name', 't');
  await sh(work, 'config', 'core.autocrlf', 'false');
  write('addons/mod_a/__manifest__.py', "{'name': 'A'}\n");
  write('addons/mod_a/models.py', 'x = 1\n');
  write('addons/mod_b/__manifest__.py', "{'name': 'B'}\n");
  write('addons/mod_b/models.py', 'y = 1\n');
  write('requirements.txt', 'pydantic\n');
  write('.gitignore', '');
  sha0 = await commitAll('base');
});

describe('code state', () => {
  it('hashes each module and the rest by content, ignoring bytecode', () => {
    const files = new Map([
      ['addons/mod_a/__manifest__.py', '1'],
      ['addons/mod_a/models.py', '2'],
      ['addons/mod_a/__pycache__/models.cpython-312.pyc', '3'],
      ['other/mod_c/__manifest__.py', '4'],
      ['README.md', '5'],
    ]);
    const all = codeStateOf(files, []);
    expect(Object.keys(all.modules)).toEqual(['mod_a', 'mod_c']);
    const roots = codeStateOf(files, ['addons']);
    // A module outside moduleRoots is part of «the rest».
    expect(Object.keys(roots.modules)).toEqual(['mod_a']);
    expect(roots.other).not.toBe(all.other);
    const pyc = new Map(files).set('addons/mod_a/__pycache__/models.cpython-312.pyc', '9');
    expect(sameCode(codeStateOf(pyc, ['addons']), roots)).toBe(true);
    const edited = new Map(files).set('addons/mod_a/models.py', '7');
    expect(codeStateOf(edited, ['addons']).modules.mod_a).not.toBe(roots.modules.mod_a);
  });

  it('a commit of the uncommitted edits has the state the folder had before it, and nothing is written to git', async () => {
    const clean = await folderCodeState(work, ['addons']);
    expect(sameCode(clean, await commitCodeState(work, sha0, ['addons']))).toBe(true);
    write('addons/mod_a/models.py', 'x = 2\n');
    write('addons/mod_a/views.xml', '<odoo/>\n');
    const objects = await sh(work, 'count-objects');
    const dirty = await folderCodeState(work, ['addons']);
    expect(await sh(work, 'count-objects')).toBe(objects);
    expect(dirty.modules.mod_a).not.toBe(clean.modules.mod_a);
    expect(dirty.modules.mod_b).toBe(clean.modules.mod_b);
    const sha = await commitAll('edit a');
    expect(sameCode(await folderCodeState(work, ['addons']), dirty)).toBe(true);
    expect(sameCode(await commitCodeState(work, sha, ['addons']), dirty)).toBe(true);
    // A deleted file changes the module.
    fs.rmSync(path.join(work, 'addons/mod_a/views.xml'));
    expect((await folderCodeState(work, ['addons'])).modules.mod_a).not.toBe(dirty.modules.mod_a);
    await sh(work, 'checkout', '--', '.');
  });

  it('manual -u updates only its modules; a failed one forgets them', () => {
    const base = { modules: { a: '1', b: '1' }, other: 'o1' };
    const now = { modules: { a: '2', b: '2', c: '1' }, other: 'o2' };
    expect(afterModules(base, now, ['a'])).toEqual({ modules: { a: '2', b: '1' }, other: 'o2' });
    expect(afterModules(base, now, ['all'])).toEqual(now);
    expect(forgetModules(base, ['a'])).toEqual({ modules: { b: '1' }, other: 'o1' });
    expect(alreadyApplied(afterModules(base, now, ['a']), now, ['a', 'b', 'c'])).toEqual(['a']);
    expect(alreadyApplied(null, now, ['a'])).toEqual([]);
    const tested = { code: codeFingerprint(now), modules: ['a', 'b'] };
    expect(testsCover(tested, now, ['a'])).toBe(true);
    expect(testsCover(tested, now, ['a', 'c'])).toBe(false);
    expect(testsCover(tested, base, ['a'])).toBe(false);
  });
});

describe('new commit of a folder branch (onNewCommit: update)', () => {
  const root = path.join(tmp, 'app');
  const dataDir = path.join(root, 'data');
  const configDir = path.join(root, 'config');
  let ctx: Ctx;
  let branchId = 0;
  let buildId = 0;
  const enqueued: string[] = [];

  beforeAll(async () => {
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
      moduleRoots: ['addons'],
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
    ctx = { store, db, sqlite, dataDir, logsDir: path.join(dataDir, 'logs'), configDir, toMain: () => {}, proxyPort: null } as unknown as Ctx;
    const now = new Date().toISOString();
    const head = await sh(work, 'rev-parse', 'HEAD');
    branchId = db
      .insert(branches)
      .values({
        projectId: 'shop',
        name: 'feat',
        slug: 'feat',
        stage: 'development',
        assignedBy: 'user',
        overrides: { folder: work, onNewCommit: 'update', tests: { mode: 'changed' } },
        createdAt: now,
        lastSeenLocalSha: head,
      })
      .returning()
      .get().id;
    buildId = db
      .insert(builds)
      .values({
        branchId,
        projectId: 'shop',
        number: 1,
        stage: 'development',
        commitSha: head,
        commits: [{ sha: head, author: 't', email: 't@t', date: now, message: 'edit a' }],
        trigger: 'manual',
        kind: 'new',
        dbSource: 'fresh',
        dbName: 'shop_feat_1',
        host: 'feat.localhost',
        composeProject: 'bm-shop-feat',
        status: 'running',
        live: true,
        codeState: await folderCodeState(work, ['addons']),
        createdAt: now,
      })
      .returning()
      .get().id;
    setQueue({ enqueue: (type: string) => (enqueued.push(type), enqueued.length) } as unknown as JobQueue);
  });
  afterAll(() => (ctx as unknown as { sqlite: { close(): void } }).sqlite.close());

  const live = () => ctx.db.select().from(builds).where(eq(builds.id, buildId)).get()!;
  /** Forgets the update build a previous case queued. */
  const reset = () => {
    ctx.db.delete(builds).where(eq(builds.status, 'queued')).run();
    enqueued.length = 0;
  };
  /** What a manual `bm modules -u` + `bm test` on the current folder leave in the live build. */
  async function manualUpdateAndTests(modules: string[]): Promise<void> {
    const now = await folderCodeState(work, ['addons']);
    ctx.db
      .update(builds)
      .set({
        codeState: afterModules(live().codeState!, now, modules),
        tests: { passed: 3, failed: 0, errors: 0, warnings: 0, failures: [] },
        testedCode: { code: codeFingerprint(now), modules },
      })
      .where(eq(builds.id, buildId))
      .run();
  }

  it('commit of code already updated and tested by hand: the live build is marked, nothing is built', async () => {
    const w = new LocalWatcher(ctx);
    await w.check(branchId);
    write('addons/mod_a/models.py', 'x = 3\n');
    await manualUpdateAndTests(['mod_a']);
    const sha = await commitAll('edit a again');
    await w.check(branchId);
    expect(enqueued).toEqual([]);
    expect(live().commitSha).toBe(sha);
    expect(live().commits.map((c) => c.message)).toEqual(['edit a again', 'edit a']);
    expect(live().tests?.passed).toBe(3);
    const a = ctx.db.select().from(auditLog).all().find((x) => x.action === 'build.sameCode');
    expect(a?.target).toBe('feat#1');
  });

  it('tests of the changed module did not run on this code: the update build runs as before', async () => {
    const w = new LocalWatcher(ctx);
    await w.check(branchId);
    write('addons/mod_a/models.py', 'x = 4\n');
    const before = live().commitSha;
    // -u by hand, but the tests ran on the previous code.
    ctx.db.update(builds).set({ codeState: afterModules(live().codeState!, await folderCodeState(work, ['addons']), ['mod_a']) }).where(eq(builds.id, buildId)).run();
    await commitAll('edit a, untested');
    await w.check(branchId);
    expect(enqueued).toEqual(['build']);
    expect(live().commitSha).toBe(before);
  });

  it('a module edited after the manual -u: the update build runs as before', async () => {
    reset();
    const w = new LocalWatcher(ctx);
    await w.check(branchId);
    write('addons/mod_b/models.py', 'y = 2\n');
    await manualUpdateAndTests(['mod_b']);
    write('addons/mod_b/models.py', 'y = 3\n');
    await commitAll('edit b after -u');
    await w.check(branchId);
    expect(enqueued).toEqual(['build']);
  });

  it('manual tests failed on this code: the build runs (it reports the failure instead of a silent mark)', async () => {
    reset();
    const w = new LocalWatcher(ctx);
    await w.check(branchId);
    write('addons/mod_a/models.py', 'x = 5\n');
    await manualUpdateAndTests(['mod_a']);
    ctx.db.update(builds).set({ tests: { passed: 2, failed: 1, errors: 0, warnings: 0, failures: ['test_a'] } }).where(eq(builds.id, buildId)).run();
    await commitAll('edit a, red tests');
    await w.check(branchId);
    expect(enqueued).toEqual(['build']);
  });
});
