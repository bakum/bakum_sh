import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { execa } from 'execa';
import { afterAll, describe, expect, it } from 'vitest';
import { isLegacyProject, projectConfigSchema } from '@bm/shared';
import * as git from '../src/git';
import { genericPreset, type PresetInputs } from '../src/config/presets';
import { resolveBranchScope } from '../src/config/effective';
import { assertOwned } from '../src/safety';
import { ConfigStore } from '../src/config/store';
import { openDb } from '../src/db';
import { auditLog, jobs, kv, type JobRow } from '../src/db/schema';
import { deleteProjectExecutor, projectDeletePreview } from '../src/services/project-delete';
import type { Ctx } from '../src/context';
import type { JobContext } from '../src/jobs/queue';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-mirror-'));
afterAll(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* Windows: read-only git objects in a temp folder, left for the OS */
  }
});

const inputs = (over: Partial<PresetInputs> = {}): PresetInputs => ({
  id: 'shop',
  name: 'shop',
  repo: { url: 'https://github.com/acme/shop.git', mirrorDir: 'C:/bm/repos/shop.git', localFolder: 'D:/work/shop' },
  github: 'acme/shop',
  remote: 'origin',
  projectRoot: null,
  worktreesDir: 'C:/bm/worktrees',
  moduleRoots: [],
  modulesToInstall: null,
  image: 'odoo:19',
  network: 'n',
  repoMount: '/mnt/repo/shop',
  mounts: [],
  filestoreHostDir: 'C:/bm/filestore/shop',
  postgres: { host: 'localhost', port: 5432, internalHost: 'db', user: 'odoo', password: '', protectedContainers: [] },
  stackAddons: ['/usr/lib/python3/dist-packages/odoo/addons'],
  productionBranch: 'main',
  odooVersion: '19.0',
  ...over,
});

describe('project settings (D33)', () => {
  it('needs the URL and the mirror; a project with only repo.path is legacy', () => {
    const cfg = projectConfigSchema.parse(genericPreset(inputs()));
    expect(isLegacyProject(cfg)).toBe(false);
    const raw = genericPreset(inputs()) as { repo: Record<string, unknown>; stages: Record<string, Record<string, unknown>> };
    const legacy = structuredClone(raw);
    legacy.repo = { ...legacy.repo, url: undefined, mirrorDir: undefined, path: 'E:/r' };
    legacy.stages.development = { ...legacy.stages.development, tracking: 'local' };
    expect(isLegacyProject(projectConfigSchema.parse(legacy))).toBe(true);
    const none = structuredClone(raw);
    none.repo = { ...none.repo, url: undefined };
    expect(() => projectConfigSchema.parse(none)).toThrow(/repo\.url/);
  });

  it('takes the folder from the branch level only, for Development only', () => {
    const raw = genericPreset(inputs()) as { stages: Record<string, Record<string, unknown>> };
    const bad = structuredClone(raw);
    bad.stages.development = { ...bad.stages.development, folder: 'D:/work/shop' };
    expect(() => projectConfigSchema.parse(bad)).toThrow(/только в настройках ветки/);
    const cfg = projectConfigSchema.parse(raw);
    expect(resolveBranchScope(cfg, 'feat', 'development', { folder: 'D:/work/shop' }).scope.folder).toBe('D:/work/shop');
    expect(resolveBranchScope(cfg, 'feat', 'production', { folder: 'D:/work/shop' }).scope.folder).toBeNull();
    expect(resolveBranchScope(cfg, 'feat', 'development', null).scope.folder).toBeNull();
  });
});

describe('safety of the mirror and the user folder', () => {
  const cfg = projectConfigSchema.parse(genericPreset(inputs()));
  const reg = { dbNames: new Set<string>(), composeProjects: new Set<string>(), worktrees: new Set(['C:/bm/worktrees/shop/main', 'D:/work/shop/x']) };

  it('removes only the project mirror inside <dataDir>/repos', () => {
    expect(() => assertOwned(cfg, { kind: 'mirror', path: 'C:\\bm\\repos\\shop.git', reposRoot: 'C:/bm/repos' }, reg)).not.toThrow();
    expect(() => assertOwned(cfg, { kind: 'mirror', path: 'C:/bm/repos/other.git', reposRoot: 'C:/bm/repos' }, reg)).toThrow(/не является копией/);
    expect(() => assertOwned(cfg, { kind: 'mirror', path: 'C:/bm/repos/shop.git', reposRoot: 'C:/elsewhere' }, reg)).toThrow(/вне папки приложения/);
  });

  it('never treats the mirror or the user folder as a worktree', () => {
    expect(() => assertOwned(cfg, { kind: 'worktree', path: 'C:/bm/worktrees/shop/main' }, reg)).not.toThrow();
    const inside = projectConfigSchema.parse(genericPreset(inputs({ worktreesDir: 'D:/work' })));
    expect(() => assertOwned(inside, { kind: 'worktree', path: 'D:/work/shop/x' }, reg)).toThrow(/ваша папка/);
  });
});

async function sh(cwd: string, ...args: string[]): Promise<string> {
  const r = await execa('git', args, { cwd, env: { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
  return String(r.stdout).trim();
}

describe('the app mirror (git)', () => {
  const origin = path.join(tmp, 'origin.git');
  const work = path.join(tmp, 'work');
  const mirror = path.join(tmp, 'repos', 'shop.git');

  it('fetches into refs/remotes, gives detached worktrees and pushes new branches', async () => {
    await sh(tmp, 'init', '--bare', '-b', 'main', origin);
    await sh(tmp, 'init', '-b', 'main', work);
    await sh(work, 'config', 'user.email', 't@t');
    await sh(work, 'config', 'user.name', 't');
    fs.mkdirSync(path.join(work, 'mod_a'));
    fs.writeFileSync(path.join(work, 'mod_a', '__manifest__.py'), "{'name': 'A', 'version': '19.0.1.0.0'}");
    await sh(work, 'add', '.');
    await sh(work, 'commit', '-m', 'init');
    await sh(work, 'remote', 'add', 'origin', origin);
    await sh(work, 'push', 'origin', 'main');
    const sha = await sh(work, 'rev-parse', 'HEAD');

    const lines: string[] = [];
    await git.initMirror(origin, mirror, { onLine: (l) => lines.push(l) });
    expect(await git.listBranches(mirror, 'origin')).toEqual([{ name: 'main', source: 'remote' }]);
    expect(await git.remoteSha(mirror, 'origin', 'main')).toBe(sha);
    expect(await git.lsTree(mirror, 'refs/remotes/origin/main')).toContain('mod_a/__manifest__.py');

    // A detached worktree in the mirror: the user's clone keeps every branch free.
    const wt = path.join(tmp, 'worktrees', 'shop', 'main');
    await git.worktreeAddDetached(mirror, wt, 'origin/main');
    expect((await git.worktreeList(mirror)).find((w) => w.path.endsWith('/main'))?.detached).toBe(true);
    expect(await git.worktreeList(work)).toHaveLength(1);
    await sh(work, 'checkout', '-b', 'feature');
    await sh(work, 'checkout', 'main');

    await git.pushNewBranch(mirror, 'origin', sha, 'feature/x');
    expect(await sh(origin, 'rev-parse', 'refs/heads/feature/x')).toBe(sha);
    // An existing branch is never moved, even by a fast-forward.
    fs.writeFileSync(path.join(work, 'readme.md'), 'x');
    await sh(work, 'add', '.');
    await sh(work, 'commit', '-m', 'second');
    await sh(work, 'push', 'origin', 'main');
    await git.fetch(mirror, 'origin');
    const sha2 = await sh(work, 'rev-parse', 'HEAD');
    await expect(git.pushNewBranch(mirror, 'origin', sha2, 'feature/x')).rejects.toThrow(/уже есть/);
    expect(await sh(origin, 'rev-parse', 'refs/heads/feature/x')).toBe(sha);
    await git.fetch(mirror, 'origin');
    expect((await git.listBranches(mirror, 'origin')).map((b) => b.name)).toEqual(['feature/x', 'main']);
  });

  it('lists uncommitted files of the user folder without changing it', async () => {
    fs.writeFileSync(path.join(work, 'mod_a', '__manifest__.py'), "{'name': 'A2', 'version': '19.0.1.0.1'}");
    fs.mkdirSync(path.join(work, 'mod_b'));
    fs.writeFileSync(path.join(work, 'mod_b', 'x.py'), '');
    expect((await git.uncommittedFiles(work)).sort()).toEqual(['mod_a/__manifest__.py', 'mod_b/x.py']);
    expect((await git.folderRemoteUrl(work)).remote).toBe('origin');
  });
});

describe('project deletion (full cleanup, D34)', () => {
  it('removes folders, logs, the settings file and registry rows of the project', async () => {
    const root = path.join(tmp, 'del');
    const dataDir = path.join(root, 'data');
    const logsDir = path.join(dataDir, 'logs');
    const configDir = path.join(root, 'config');
    const mirrorDir = path.join(dataDir, 'repos', 'shop.git');
    const userFolder = path.join(root, 'my-clone');
    for (const d of [mirrorDir, userFolder, path.join(dataDir, 'projects', 'shop', 'branches', 'main'), path.join(logsDir, 'builds', 'shop'), path.join(logsDir, 'jobs')]) {
      fs.mkdirSync(d, { recursive: true });
    }
    fs.writeFileSync(path.join(mirrorDir, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(userFolder, 'keep.txt'), 'mine');
    fs.writeFileSync(path.join(dataDir, 'projects', 'shop', 'branches', 'main', 'compose.yml'), '');
    fs.writeFileSync(path.join(logsDir, 'builds', 'shop', 'main-1.log'), '');
    fs.mkdirSync(path.join(root, 'worktrees', 'shop'), { recursive: true });

    const store = new ConfigStore(configDir);
    store.load();
    const cfg = genericPreset(
      inputs({ repo: { url: 'https://github.com/acme/shop.git', mirrorDir: mirrorDir.replace(/\\/g, '/'), localFolder: userFolder.replace(/\\/g, '/') }, worktreesDir: path.join(root, 'worktrees').replace(/\\/g, '/') }),
    );
    store.putProject(YAML.stringify(cfg), { create: true });
    const { db, sqlite } = openDb(path.join(root, 'registry.sqlite'));
    const ctx = { store, db, sqlite, dataDir, logsDir, configDir, toMain: () => {}, proxyPort: null } as unknown as Ctx;
    const now = new Date().toISOString();
    const fetchJob = db.insert(jobs).values({ type: 'fetch', status: 'success', projectId: 'shop', params: {}, createdAt: now }).returning().get();
    fs.writeFileSync(path.join(logsDir, 'jobs', `${fetchJob.id}-fetch.log`), '');
    const delJob = db.insert(jobs).values({ type: 'delete_project', status: 'running', projectId: 'shop', params: {}, createdAt: now }).returning().get();
    db.insert(auditLog).values({ projectId: 'shop', at: now, action: 'x', target: 'y', params: {}, result: 'ok' }).run();
    db.insert(kv).values({ key: 'autoadd-skip:shop:old', value: now }).run();
    db.insert(kv).values({ key: 'autoadd-skip:other:old', value: now }).run();

    const pv = projectDeletePreview(ctx, 'shop');
    expect(pv.folders.length).toBe(4);
    expect(pv.registry).toEqual({ jobs: 2, audit: 1, kv: 1 });

    const jc = { log: () => {}, signal: new AbortController().signal } as unknown as JobContext;
    await deleteProjectExecutor(ctx, delJob as JobRow, jc);

    expect(fs.existsSync(mirrorDir)).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'projects', 'shop'))).toBe(false);
    expect(fs.existsSync(path.join(logsDir, 'builds', 'shop'))).toBe(false);
    expect(fs.existsSync(path.join(logsDir, 'jobs', `${fetchJob.id}-fetch.log`))).toBe(false);
    expect(fs.existsSync(path.join(root, 'worktrees', 'shop'))).toBe(false);
    expect(fs.readdirSync(configDir, { recursive: true }).filter((f) => String(f).includes('shop'))).toEqual([]);
    expect(fs.readFileSync(path.join(userFolder, 'keep.txt'), 'utf8')).toBe('mine');
    expect(db.select().from(jobs).all().map((j) => j.id)).toEqual([delJob.id]);
    expect(db.select().from(auditLog).all().map((a) => a.action)).toEqual(['project.delete']);
    expect(db.select().from(kv).all().map((k) => k.key)).toEqual(['autoadd-skip:other:old']);
    sqlite.close();
  });
});
