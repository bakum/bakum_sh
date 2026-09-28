import path from 'node:path';
import { execa } from 'execa';
import { BmError, type CommitInfo, type GitBranchInfo } from '@bm/shared';
import { toPosix } from '../util/paths';

/**
 * Git CLI wrapper. Only the operations allowed by the safety rules are exposed:
 * fetch, worktree add/remove, branch create / delete -d, detached checkout inside app worktrees, read-only queries.
 */
async function git(cwd: string, args: string[], opts: { timeoutMs?: number; allowFail?: boolean } = {}): Promise<string> {
  const r = await execa('git', args, {
    cwd,
    reject: false,
    timeout: opts.timeoutMs ?? 60_000,
    env: { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    windowsHide: true,
    stripFinalNewline: true,
  });
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

/** `git fetch <remote>` (no prune, no tags rewrite): the only network operation the app performs. */
export async function fetch(repo: string, remote: string): Promise<void> {
  await git(repo, ['fetch', '--no-tags', remote], { timeoutMs: 180_000 });
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

/** Where a local branch is checked out (main checkout or another worktree), if anywhere. */
export async function branchCheckedOutAt(repo: string, branch: string): Promise<string | null> {
  const wts = await worktreeList(repo);
  return wts.find((w) => w.branch === branch)?.path ?? null;
}

export async function worktreeAddDetached(repo: string, dir: string, ref: string): Promise<void> {
  await git(repo, ['worktree', 'add', '--detach', toPosix(dir), ref], { timeoutMs: 300_000 });
}

export async function worktreeAddBranch(repo: string, dir: string, branch: string): Promise<void> {
  await git(repo, ['worktree', 'add', toPosix(dir), branch], { timeoutMs: 300_000 });
}

export async function worktreeAddTrack(repo: string, dir: string, branch: string, remote: string): Promise<void> {
  await git(repo, ['worktree', 'add', '--track', '-b', branch, toPosix(dir), `${remote}/${branch}`], { timeoutMs: 300_000 });
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

export async function branchCreate(repo: string, name: string, start: string): Promise<void> {
  await git(repo, ['check-ref-format', '--branch', name]);
  await git(repo, ['branch', name, start]);
}

/** Safe delete only (`-d`): refuses to delete unmerged work. */
export async function branchDeleteSafe(repo: string, name: string): Promise<void> {
  await git(repo, ['branch', '-d', name]);
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
