import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { BmError, type CommitInfo, type GitBranchInfo } from '@bm/shared';
import { toPosix } from '../util/paths';

/**
 * Background git calls never ask anything: no terminal prompt, no Git Credential Manager window (D31).
 * Only an explicit «Войти» in the wizard lets the credential helper show its sign-in window.
 */
const QUIET_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C' };

export const GIT_MISSING_TEXT = 'Git не найден. Установите Git for Windows (https://git-scm.com/download/win) и перезапустите приложение.';

/** execa (reject: false) returns the spawn error as the result: `code: 'ENOENT'` when git.exe is not on PATH. */
function assertGitFound(r: unknown): void {
  if ((r as { code?: unknown } | null)?.code === 'ENOENT') throw new BmError('GIT_MISSING', GIT_MISSING_TEXT);
}

/**
 * Git CLI wrapper. Only the operations allowed by the safety rules are exposed (D33): in the app's own mirror — fetch,
 * detached worktree add/remove, detached checkout inside app worktrees, push of a new branch (Fork); clone into a new
 * folder; credential approve / reject of a token the user entered; read-only queries anywhere else (the user's folder).
 */
async function git(
  cwd: string,
  args: string[],
  opts: { timeoutMs?: number; allowFail?: boolean; env?: Record<string, string>; input?: string } = {},
): Promise<string> {
  const r = await execa('git', args, {
    cwd,
    reject: false,
    timeout: opts.timeoutMs ?? 60_000,
    env: { ...QUIET_ENV, ...opts.env },
    windowsHide: true,
    stripFinalNewline: true,
    input: opts.input,
  });
  assertGitFound(r);
  if (r.exitCode !== 0 && !opts.allowFail) {
    const msg = (r.stderr || r.stdout || '').toString().trim();
    throw new BmError('GIT', `git ${args[0]}: ${msg || `код ${r.exitCode}`}`, { args, exitCode: r.exitCode });
  }
  return (r.stdout ?? '').toString();
}

export async function topLevel(dir: string): Promise<string | null> {
  const out = await git(dir, ['rev-parse', '--show-toplevel'], { allowFail: true });
  return out ? toPosix(out.trim()) : null;
}

export async function remotes(repo: string): Promise<string[]> {
  return (await git(repo, ['remote'])).split('\n').filter(Boolean);
}

export async function remoteUrl(repo: string, remote: string): Promise<string | null> {
  const out = await git(repo, ['remote', 'get-url', remote], { allowFail: true });
  return out.trim() || null;
}

export function githubFromUrl(url: string | null): string | null {
  if (!url) return null;
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Branch checked out in the main checkout of the repository (null if detached). */
export async function currentBranch(repo: string): Promise<string | null> {
  const out = (await git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true })).trim();
  return out || null;
}

export async function listBranches(repo: string, remote: string): Promise<GitBranchInfo[]> {
  const out = await git(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads', `refs/remotes/${remote}`]);
  const map = new Map<string, GitBranchInfo['source']>();
  for (const ref of out.split('\n').filter(Boolean)) {
    let name: string;
    let src: 'local' | 'remote';
    if (ref.startsWith('refs/heads/')) {
      name = ref.slice('refs/heads/'.length);
      src = 'local';
    } else {
      name = ref.slice(`refs/remotes/${remote}/`.length);
      if (name === 'HEAD') continue;
      src = 'remote';
    }
    const prev = map.get(name);
    map.set(name, prev && prev !== src ? 'both' : src);
  }
  return [...map.entries()].map(([name, source]) => ({ name, source })).sort((a, b) => a.name.localeCompare(b.name));
}

/** `git fetch --prune <remote>` into the app's own mirror (D49): branches deleted on the remote disappear; no tags. */
export async function fetch(repo: string, remote: string): Promise<void> {
  const r = await execa('git', ['fetch', '--prune', '--no-tags', remote], { cwd: repo, reject: false, timeout: 180_000, env: QUIET_ENV, windowsHide: true });
  assertGitFound(r);
  if (r.exitCode === 0) return;
  const stderr = String(r.stderr || r.stdout || (r.timedOut ? 'timed out' : ''));
  const c = classifyRemoteError(stderr);
  const text = c.problem === 'auth' || c.problem === 'denied' ? `нет доступа к репозиторию. ${c.message}` : c.problem === 'other' ? stderr.trim() : c.message;
  throw new BmError('GIT', text, { problem: c.problem });
}

/** `git --version`, null when git is not installed. */
export async function version(): Promise<string | null> {
  const r = await execa('git', ['--version'], { reject: false, windowsHide: true });
  return r.exitCode === 0 ? String(r.stdout).trim() : null;
}

export type RemoteProblem = 'auth' | 'denied' | 'ssh-key' | 'host-key' | 'network' | 'other';

/** Kind of a failed network git call, from its stderr (LC_ALL=C). */
export function classifyRemoteError(stderr: string): { problem: RemoteProblem; message: string } {
  const s = stderr.trim();
  const last = s.split('\n').filter(Boolean).slice(-3).join('\n');
  if (/Host key verification failed/i.test(s)) {
    return { problem: 'host-key', message: 'Хост SSH ещё не известен. Один раз выполните в терминале `ssh -T git@github.com` (или другой хост) и подтвердите ключ.' };
  }
  if (/Permission denied \(publickey/i.test(s)) {
    return { problem: 'ssh-key', message: 'SSH-ключ не принят: добавьте публичный ключ в аккаунт GitHub или используйте https-адрес.' };
  }
  if (/could not read (Username|Password)|terminal prompts disabled|Authentication failed|invalid username or password|HTTP Basic: Access denied|\b401\b/i.test(s)) {
    return { problem: 'auth', message: 'Нужен вход: репозиторий приватный, а сохранённых учётных данных нет или они устарели.' };
  }
  if (/Repository not found|not found|\b403\b|\b404\b|access denied|not authorized/i.test(s)) {
    return {
      problem: 'denied',
      message: 'Репозиторий не найден или у этой учётной записи нет к нему доступа. Проверьте адрес, войдите другим аккаунтом или сохраните токен с доступом к репозиторию.',
    };
  }
  if (/Could not resolve host|unable to access|Connection (timed out|refused)|Failed to connect|timed out/i.test(s)) {
    return { problem: 'network', message: `Нет соединения с сервером репозитория: ${last}` };
  }
  return { problem: 'other', message: last || 'git завершился с ошибкой' };
}

/**
 * `git ls-remote --symref <url> HEAD refs/heads/*` — access check and branch list without a clone.
 * `interactive` lets Git Credential Manager show its sign-in window (the only interactive git call).
 */
export async function lsRemote(
  url: string,
  opts: { interactive?: boolean; timeoutMs?: number } = {},
): Promise<{ ok: true; branches: string[]; head: string | null } | { ok: false; stderr: string }> {
  const r = await execa('git', ['ls-remote', '--symref', url, 'HEAD', 'refs/heads/*'], {
    cwd: os.homedir(),
    reject: false,
    timeout: opts.timeoutMs ?? 45_000,
    env: { ...QUIET_ENV, ...(opts.interactive ? { GCM_INTERACTIVE: 'auto' } : {}) },
    windowsHide: true,
  });
  assertGitFound(r);
  if (r.exitCode !== 0) return { ok: false, stderr: String(r.stderr || r.stdout || (r.timedOut ? 'timed out' : '')) };
  let head: string | null = null;
  const branches: string[] = [];
  for (const line of String(r.stdout).split('\n')) {
    const sym = /^ref: refs\/heads\/(\S+)\s+HEAD$/.exec(line.trim());
    if (sym) head = sym[1]!;
    const ref = /^[0-9a-f]{40,64}\s+refs\/heads\/(\S+)$/.exec(line.trim());
    if (ref) branches.push(ref[1]!);
  }
  return { ok: true, branches: branches.sort(), head };
}

/** Puts a user name into an https URL (the credential helper then picks the matching stored credential). */
export function withUser(url: string, user: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = '';
  return u.toString();
}

/** Credential helper configured for the URL (`credential.helper`), null when none. */
export async function credentialHelper(url: string): Promise<string | null> {
  const out = await git(os.homedir(), ['config', '--get-urlmatch', 'credential.helper', url], { allowFail: true });
  return out.trim().split('\n').filter(Boolean).pop() ?? null;
}

function credentialInput(url: string, username: string, token: string): string {
  const u = new URL(url);
  return `protocol=${u.protocol.replace(':', '')}\nhost=${u.host}\nusername=${username}\npassword=${token}\n\n`;
}

/** `git credential approve`: the helper (Windows Credential Manager via GCM) stores the token; the app keeps nothing. */
export async function credentialApprove(url: string, username: string, token: string): Promise<void> {
  await git(os.homedir(), ['credential', 'approve'], { input: credentialInput(url, username, token), timeoutMs: 30_000 });
}

/** `git credential reject`: removes a token that turned out not to work. */
export async function credentialReject(url: string, username: string, token: string): Promise<void> {
  await git(os.homedir(), ['credential', 'reject'], { input: credentialInput(url, username, token), timeoutMs: 30_000, allowFail: true });
}

/** Runs a network git command whose stderr carries progress lines (percent updates are thinned out). */
async function runWithProgress(
  cwd: string,
  args: string[],
  opts: { onLine: (line: string) => void; signal?: AbortSignal; timeoutMs?: number },
): Promise<{ exitCode: number | undefined; isCanceled: boolean; stderr: string }> {
  const sub = execa('git', args, {
    cwd,
    reject: false,
    all: true,
    cancelSignal: opts.signal,
    timeout: opts.timeoutMs ?? 3 * 3600_000,
    env: QUIET_ENV,
    windowsHide: true,
  });
  let buf = '';
  const lastPct = new Map<string, number>();
  const emit = (raw: string): void => {
    const line = raw.trim();
    if (!line) return;
    const m = /^(.*?):\s+(\d+)%/.exec(line);
    if (m) {
      const pct = Number(m[2]);
      const prev = lastPct.get(m[1]!) ?? -100;
      if (pct < 100 && pct - prev < 10) return;
      lastPct.set(m[1]!, pct);
    }
    opts.onLine(line);
  };
  sub.all?.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let i: number;
    while ((i = buf.search(/[\r\n]/)) >= 0) {
      emit(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  const r = await sub;
  emit(buf);
  assertGitFound(r);
  return { exitCode: r.exitCode, isCanceled: !!r.isCanceled, stderr: String(r.stderr ?? r.all ?? '') };
}

/**
 * `git clone` into a new folder with progress lines (Enterprise addons).
 * Never interactive: access is checked (and granted) in the wizard beforehand.
 */
export async function clone(
  url: string,
  dir: string,
  opts: { branch?: string; shallow?: boolean; onLine: (line: string) => void; signal?: AbortSignal },
): Promise<void> {
  const args = ['clone', '--progress'];
  if (opts.branch) args.push('--branch', opts.branch, '--single-branch');
  if (opts.shallow) args.push('--depth', '1');
  args.push('--', url, dir);
  const r = await runWithProgress(os.homedir(), args, opts);
  if (r.isCanceled) throw new BmError('CANCELLED', 'Клонирование отменено');
  if (r.exitCode !== 0) {
    const c = classifyRemoteError(r.stderr);
    throw new BmError('GIT_CLONE', `git clone: ${c.message}`, { problem: c.problem });
  }
}

/**
 * The app's own bare mirror of a remote (D33): `init --bare`, remote with the refspec
 * `+refs/heads/*:refs/remotes/<remote>/*` (so `<remote>/<branch>` refs look like in a normal clone), first fetch.
 * The user never works in it; worktrees made from it are always detached, so git never locks a branch.
 */
export async function initMirror(
  url: string,
  dir: string,
  opts: { remote?: string; onLine: (line: string) => void; signal?: AbortSignal },
): Promise<void> {
  const remote = opts.remote ?? 'origin';
  await git(os.homedir(), ['init', '--bare', '--quiet', toPosix(dir)]);
  await git(dir, ['remote', 'add', remote, url]);
  await git(dir, ['config', `remote.${remote}.fetch`, `+refs/heads/*:refs/remotes/${remote}/*`]);
  const r = await runWithProgress(dir, ['fetch', '--progress', '--no-tags', remote], opts);
  if (r.isCanceled) throw new BmError('CANCELLED', 'Загрузка отменена');
  if (r.exitCode !== 0) {
    const c = classifyRemoteError(r.stderr);
    throw new BmError('GIT_CLONE', `git fetch: ${c.message}`, { problem: c.problem });
  }
}

/** Top level, remote and its URL of a folder (the user's clone); read-only. */
export async function folderRemoteUrl(dir: string): Promise<{ top: string; remote: string | null; url: string | null }> {
  const top = await topLevel(dir);
  if (!top) throw new BmError('NOT_A_REPO', `Папка «${dir}» не является git-репозиторием.`);
  const list = await remotes(top);
  const remote = list.includes('origin') ? 'origin' : (list[0] ?? null);
  let url = remote ? await remoteUrl(top, remote) : null;
  // A remote that is a local or network folder becomes a file:/// URL (the form the wizard accepts).
  if (url && /^([A-Za-z]:[\\/]|\\\\|\/\/)/.test(url)) {
    const p = toPosix(url);
    url = p.startsWith('//') ? `file:${p}` : `file:///${p}`;
  }
  return { top, remote, url };
}

/**
 * Creates a branch on the remote (Fork, D33): `git push <remote> <sha>:refs/heads/<name>` from the mirror with the
 * credentials the Git credential helper already has. Never forces, never interactive.
 */
export async function pushNewBranch(mirror: string, remote: string, sha: string, name: string): Promise<void> {
  // An empty lease: the push only creates the branch, it never moves an existing one.
  const r = await execa('git', ['push', '--porcelain', `--force-with-lease=refs/heads/${name}:`, remote, `${sha}:refs/heads/${name}`], {
    cwd: mirror,
    reject: false,
    timeout: 180_000,
    env: QUIET_ENV,
    windowsHide: true,
  });
  assertGitFound(r);
  if (r.exitCode === 0) return;
  // --porcelain puts the per-ref status («[rejected] (stale info)») on stdout, the transport errors on stderr.
  const out = [r.stdout, r.stderr, r.timedOut ? 'timed out' : ''].map((x) => String(x ?? '')).filter(Boolean).join('\n');
  if (/Permission to .* denied|\b403\b|write access|protected branch|not allowed to push/i.test(out)) {
    throw new BmError(
      'GIT_PUSH',
      'Нет прав на запись в репозиторий. Войдите учётной записью с правом push или сохраните токен с доступом Contents — Read and write.',
      { problem: 'denied' },
    );
  }
  if (/already exists|\[rejected\]|stale info|non-fast-forward/i.test(out)) {
    throw new BmError('BRANCH_EXISTS', `Ветка «${name}» уже есть в репозитории. Выполните fetch.`);
  }
  const c = classifyRemoteError(out);
  throw new BmError('GIT_PUSH', `git push: ${c.problem === 'other' ? String(r.stderr || out).trim() : c.message}`, { problem: c.problem });
}

export async function revParse(cwd: string, ref: string): Promise<string | null> {
  const out = (await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true })).trim();
  return out || null;
}

export async function remoteSha(repo: string, remote: string, branch: string): Promise<string | null> {
  return revParse(repo, `refs/remotes/${remote}/${branch}`);
}

export async function localSha(repo: string, branch: string): Promise<string | null> {
  return revParse(repo, `refs/heads/${branch}`);
}

export interface WorktreeInfo {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  prunable: boolean;
}

export async function worktreeList(repo: string): Promise<WorktreeInfo[]> {
  const out = await git(repo, ['worktree', 'list', '--porcelain']);
  const items: WorktreeInfo[] = [];
  let cur: WorktreeInfo | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: toPosix(line.slice(9)), head: null, branch: null, detached: false, bare: false, prunable: false };
      items.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line === 'bare') cur.bare = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
  }
  return items;
}

export async function worktreeAddDetached(repo: string, dir: string, ref: string): Promise<void> {
  await git(repo, ['worktree', 'add', '--detach', toPosix(dir), ref], { timeoutMs: 300_000 });
}

export async function worktreeRemove(repo: string, dir: string, force: boolean): Promise<void> {
  await git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), toPosix(dir)], { timeoutMs: 120_000 });
}

export async function worktreePrune(repo: string): Promise<void> {
  await git(repo, ['worktree', 'prune'], { allowFail: true });
}

export async function checkoutDetach(worktree: string, sha: string): Promise<void> {
  await git(worktree, ['checkout', '--detach', sha], { timeoutMs: 120_000 });
}

export async function statusPorcelain(worktree: string): Promise<string> {
  return git(worktree, ['status', '--porcelain']);
}

/** Files changed but not committed in a folder (modified, staged, untracked), repo-relative; read-only. */
export async function uncommittedFiles(dir: string): Promise<string[]> {
  const out = await git(dir, ['status', '--porcelain', '--untracked-files=all', '--no-renames']);
  return out
    .split('\n')
    .filter((l) => l.length > 3)
    .map((l) => l.slice(3).replace(/^"(.*)"$/, '$1'));
}

export async function headSha(worktree: string): Promise<string | null> {
  return revParse(worktree, 'HEAD');
}

/** Absolute git dir of a worktree (`.git/worktrees/<name>`), used for HEAD watching. */
export async function gitDir(worktree: string): Promise<string | null> {
  const out = (await git(worktree, ['rev-parse', '--absolute-git-dir'], { allowFail: true })).trim();
  return out ? toPosix(out) : null;
}

export async function commonDir(repo: string): Promise<string> {
  const out = (await git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  return toPosix(out);
}

export async function diffNames(repo: string, from: string, to: string): Promise<string[]> {
  const out = await git(repo, ['diff', '--name-only', '--no-renames', `${from}..${to}`]);
  return out.split('\n').filter(Boolean);
}

export async function isAncestor(repo: string, a: string, b: string): Promise<boolean> {
  const r = await execa('git', ['merge-base', '--is-ancestor', a, b], { cwd: repo, reject: false, windowsHide: true });
  return r.exitCode === 0;
}

/** Number of commits in `to` that are not in `from` (`git rev-list --count from..to`). */
export async function countBetween(repo: string, from: string, to: string): Promise<number> {
  return Number((await git(repo, ['rev-list', '--count', `${from}..${to}`])).trim()) || 0;
}

/** Best common ancestor of two commits, null when there is none. */
export async function mergeBase(repo: string, a: string, b: string): Promise<string | null> {
  const out = (await git(repo, ['merge-base', a, b], { allowFail: true })).trim();
  return out || null;
}

const SEP = '\x1f';
const REC = '\x1e';

/** Commits in (from, to]; with no `from` — the last `limit` commits of `to`. */
export async function commitsBetween(repo: string, from: string | null, to: string, limit = 50): Promise<CommitInfo[]> {
  const range = from ? `${from}..${to}` : to;
  const out = await git(repo, ['log', `-n${limit}`, `--format=%H${SEP}%an${SEP}%aI${SEP}%s${REC}`, range], { allowFail: true });
  return out
    .split(REC)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, author, date, message] = r.split(SEP);
      return { sha: sha!, author: author ?? '', date: date ?? '', message: message ?? '' };
    });
}

export async function showFile(repo: string, sha: string, file: string): Promise<string | null> {
  const r = await execa('git', ['show', `${sha}:${file}`], { cwd: repo, reject: false, windowsHide: true });
  return r.exitCode === 0 ? String(r.stdout) : null;
}

export async function lsTree(repo: string, sha: string): Promise<string[]> {
  const out = await git(repo, ['ls-tree', '-r', '--name-only', sha]);
  return out.split('\n').filter(Boolean);
}

export async function isValidBranchName(repo: string, name: string): Promise<boolean> {
  const r = await execa('git', ['check-ref-format', '--branch', name], { cwd: repo, reject: false, windowsHide: true });
  return r.exitCode === 0;
}

export const worktreeName = (dir: string): string => path.basename(dir);
