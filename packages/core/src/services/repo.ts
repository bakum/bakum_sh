import fs from 'node:fs';
import path from 'node:path';
import { BmError, type RepoProbe } from '@bm/shared';
import type { Ctx } from '../context';
import type { JobRow } from '../db/schema';
import * as git from '../git';
import { getQueue, type JobContext } from '../jobs/queue';
import { audit } from './audit';
import { requestFetch } from './fetch';
import { toPosix } from '../util/paths';

/**
 * Access to a remote repository before it is cloned (docs/decisions.md D31). Credentials are never stored by the app:
 * the sign-in window and the token go to the Git credential helper (Git Credential Manager → Windows Credential Manager).
 */
export async function probeRepo(url: string, interactive = false): Promise<RepoProbe> {
  const https = url.startsWith('https://');
  const helper = https ? await git.credentialHelper(url) : null;
  const r = await git.lsRemote(url, { interactive, timeoutMs: interactive ? 300_000 : 45_000 });
  const base = { url, https, helper };
  if (r.ok) {
    return { ...base, ok: true, problem: null, message: null, branches: r.branches, defaultBranch: r.head ?? r.branches[0] ?? null };
  }
  const c = git.classifyRemoteError(r.stderr);
  if (c.problem === 'auth' && https && !helper) {
    return {
      ...base,
      ok: false,
      problem: 'no-helper',
      message:
        'В Git не настроено хранилище учётных данных (credential.helper), поэтому войти в приватный репозиторий нельзя. ' +
        'Установите Git for Windows с Git Credential Manager или выполните `git config --global credential.helper manager`.',
      branches: [],
      defaultBranch: null,
    };
  }
  return { ...base, ok: false, problem: c.problem, message: c.message, branches: [], defaultBranch: null };
}

/**
 * Saves a personal access token through `git credential approve` under a fixed user name, which is written into the
 * clone URL so the helper returns exactly this credential. A token that does not open the repository is rejected again.
 */
export async function saveToken(url: string, username: string, token: string): Promise<RepoProbe> {
  if (!url.startsWith('https://')) throw new BmError('BAD_URL', 'Токен подходит только для https-адреса. Для SSH нужен ключ.');
  const helper = await git.credentialHelper(url);
  if (!helper) return probeRepo(url);
  const withUser = git.withUser(url, username);
  await git.credentialApprove(withUser, username, token);
  const p = await probeRepo(withUser);
  if (!p.ok) {
    await git.credentialReject(withUser, username, token);
    return { ...p, message: `Токен не подошёл: ${p.message ?? ''}`.trim() };
  }
  return p;
}

/** «Войти» for an existing project whose fetch lost access: sign-in window, then a fetch right away. */
export async function loginProject(ctx: Ctx, projectId: string): Promise<RepoProbe> {
  const cfg = ctx.store.require(projectId);
  const url = cfg.repo.url ?? (cfg.repo.path ? await git.remoteUrl(cfg.repo.path, cfg.repo.remote) : null);
  if (!url) throw new BmError('NO_REMOTE', `У репозитория нет remote «${cfg.repo.remote}»`);
  const p = await probeRepo(url, true);
  if (p.ok) requestFetch(ctx, projectId);
  return p;
}

export function repoNameFromUrl(url: string): string {
  const m = /([^/:]+?)(?:\.git)?\/?$/.exec(url.trim());
  return (m?.[1] ?? 'repo').replace(/[^\w.-]/g, '-');
}

/** `<dataDir>/repos/<name><suffix>`, the first one that does not exist yet. */
export function defaultCloneDir(ctx: Ctx, url: string, suffix = ''): string {
  const base = path.join(ctx.dataDir, 'repos', `${repoNameFromUrl(url)}${suffix}`);
  let dir = base;
  for (let i = 2; fs.existsSync(dir); i++) dir = `${base}-${i}`;
  return toPosix(dir);
}

/**
 * Clone job: `mirror` — the app's own bare mirror of the project repository in `<dataDir>/repos` (D33);
 * otherwise a normal clone into a new folder (Odoo Enterprise addons).
 */
export function requestClone(ctx: Ctx, p: { url: string; dir?: string; branch?: string; shallow: boolean; mirror: boolean }): { jobId: number; dir: string } {
  const dir = p.mirror ? defaultCloneDir(ctx, p.url, '.git') : p.dir ? path.resolve(p.dir) : null;
  if (!dir || (!p.mirror && !path.isAbsolute(p.dir!))) throw new BmError('BAD_DIR', 'Укажите полный путь к папке');
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new BmError('DIR_NOT_EMPTY', `Папка ${dir} уже существует и не пуста. Выберите другую.`);
  const params = { url: p.url, dir: toPosix(dir), branch: p.branch ?? null, shallow: p.shallow, mirror: p.mirror };
  audit(ctx, { action: p.mirror ? 'repo.mirror' : 'repo.clone', target: p.url, params });
  return { jobId: getQueue().enqueue('clone', {}, params), dir: toPosix(dir) };
}

/** Job `clone`. A folder the job created is removed again when the clone fails. */
export async function cloneExecutor(_ctx: Ctx, job: JobRow, jc: JobContext): Promise<void> {
  const p = job.params as { url: string; dir: string; branch: string | null; shallow: boolean; mirror?: boolean };
  const existed = fs.existsSync(p.dir);
  if (existed && fs.readdirSync(p.dir).length) throw new BmError('DIR_NOT_EMPTY', `Папка ${p.dir} не пуста`);
  fs.mkdirSync(path.dirname(p.dir), { recursive: true });
  try {
    if (p.mirror) {
      jc.log(`копия репозитория приложения: git init --bare ${p.dir} + git fetch ${p.url}`);
      await git.initMirror(p.url, p.dir, { onLine: jc.log, signal: jc.signal });
    } else {
      jc.log(`git clone ${p.branch ? `--branch ${p.branch} --single-branch ` : ''}${p.shallow ? '--depth 1 ' : ''}${p.url} ${p.dir}`);
      await git.clone(p.url, p.dir, { branch: p.branch ?? undefined, shallow: p.shallow, onLine: jc.log, signal: jc.signal });
    }
  } catch (err) {
    if (!existed) fs.rmSync(p.dir, { recursive: true, force: true });
    else for (const f of fs.readdirSync(p.dir)) fs.rmSync(path.join(p.dir, f), { recursive: true, force: true });
    throw err;
  }
  jc.log('готово');
}
