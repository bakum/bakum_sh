import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as git from '../git';

/**
 * Content of the code a build's database was brought to (D76, builds from the user's folder): a hash per module inside
 * moduleRoots and one hash of everything else (requirements, modules outside the roots…). It is compared by content,
 * not by commit: committing files the database has already got changes the commit but not the state.
 */
export interface CodeState {
  modules: Record<string, string>;
  other: string;
}

/** Code the result of the Test badge was obtained on (D76): fingerprint of the whole state and the tested modules. */
export interface TestedCode {
  code: string;
  modules: string[];
}

/** Bytecode Odoo writes into the mounted code is not the user's code. */
const BYTECODE = /(^|\/)__pycache__\/|\.pyc$/;

const digest = (lines: string[]): string => crypto.createHash('sha1').update([...lines].sort().join('\n')).digest('hex').slice(0, 16);

/** State of a file listing (repo-relative path → git object id). */
export function codeStateOf(files: ReadonlyMap<string, string>, roots: string[]): CodeState {
  const inRoots = (dir: string): boolean => !roots.length || roots.some((r) => dir === r || dir.startsWith(`${r}/`));
  const moduleDirs = new Set<string>();
  for (const f of files.keys()) {
    if (!f.endsWith('/__manifest__.py')) continue;
    const dir = f.slice(0, -'/__manifest__.py'.length);
    if (inRoots(dir)) moduleDirs.add(dir);
  }
  const byModule = new Map<string, string[]>();
  const other: string[] = [];
  for (const [f, id] of files) {
    if (BYTECODE.test(f)) continue;
    const parts = f.split('/');
    let dir: string | null = null;
    for (let i = parts.length - 1; i > 0 && !dir; i--) {
      const d = parts.slice(0, i).join('/');
      if (moduleDirs.has(d)) dir = d;
    }
    const line = `${f} ${id}`;
    if (!dir) {
      other.push(line);
      continue;
    }
    const name = dir.split('/').pop()!;
    byModule.set(name, [...(byModule.get(name) ?? []), line]);
  }
  const modules: Record<string, string> = {};
  for (const [name, lines] of [...byModule].sort(([a], [b]) => a.localeCompare(b))) modules[name] = digest(lines);
  return { modules, other: digest(other) };
}

/** State of a commit. */
export async function commitCodeState(repo: string, sha: string, roots: string[]): Promise<CodeState> {
  return codeStateOf(await git.lsTreeObjects(repo, sha), roots);
}

/**
 * State of the user's folder as Odoo sees it: HEAD with the uncommitted edits on top. Read-only — the edited files are
 * hashed with `git hash-object` without -w, nothing is written to the repository.
 */
export async function folderCodeState(dir: string, roots: string[]): Promise<CodeState> {
  const files = await git.lsTreeObjects(dir, 'HEAD');
  const dirty = (await git.uncommittedPaths(dir)).filter((f) => !BYTECODE.test(f));
  const present: string[] = [];
  for (const f of dirty) {
    const st = fs.statSync(path.join(dir, f), { throwIfNoEntry: false });
    if (!st) files.delete(f);
    // A changed submodule or another non-file: never equal to anything, so nothing is skipped because of it.
    else if (!st.isFile()) files.set(f, `changed:${crypto.randomUUID()}`);
    else present.push(f);
  }
  const ids = await git.hashFiles(dir, present);
  present.forEach((f, i) => files.set(f, ids[i] ?? `changed:${crypto.randomUUID()}`));
  return codeStateOf(files, roots);
}

/** One hash of the whole state. */
export function codeFingerprint(s: CodeState): string {
  return digest([`:other ${s.other}`, ...Object.entries(s.modules).map(([n, h]) => `${n} ${h}`)]);
}

export const sameCode = (a: CodeState, b: CodeState): boolean => codeFingerprint(a) === codeFingerprint(b);

/**
 * The database after a manual `-u` / `-i` (D76): the listed modules (all for `-u all`) and the files outside modules
 * (the container was restarted) are those of `now`, the rest stays as it was.
 */
export function afterModules(base: CodeState, now: CodeState, modules: string[]): CodeState {
  if (modules.includes('all')) return now;
  const res = { ...base.modules };
  for (const m of modules) {
    if (now.modules[m]) res[m] = now.modules[m];
    else delete res[m];
  }
  return { modules: res, other: now.other };
}

/** A failed `-u` / `-i` leaves the listed modules in an unknown state: they never count as already updated. */
export function forgetModules(base: CodeState, modules: string[]): CodeState {
  const res = { ...base.modules };
  for (const m of modules) delete res[m];
  return { modules: res, other: base.other };
}

/** Of `names`, the modules whose code in `now` is what the database already got (`applied`). */
export function alreadyApplied(applied: CodeState | null | undefined, now: CodeState | null | undefined, names: string[]): string[] {
  if (!applied || !now) return [];
  return names.filter((n) => !!applied.modules[n] && applied.modules[n] === now.modules[n]);
}

/** Whether a test result obtained on `tested` covers `modules` on the code `now`. */
export function testsCover(tested: TestedCode | null | undefined, now: CodeState | null | undefined, modules: string[]): boolean {
  if (!tested || !now || tested.code !== codeFingerprint(now)) return false;
  return modules.every((m) => tested.modules.includes(m));
}
