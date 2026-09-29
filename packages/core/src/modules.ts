import fs from 'node:fs';
import path from 'node:path';
import { globToRegex } from './config/rules';

/** Odoo module = directory with __manifest__.py; `dir` is repo-relative, forward slashes. */
export interface ModuleInfo {
  name: string;
  dir: string;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.idea', '.vscode']);

/** Filesystem scan (project detection). Depth counts directories below `root`. */
export function scanModules(root: string, maxDepth = 4): ModuleInfo[] {
  const out: ModuleInfo[] = [];
  const walk = (rel: string, depth: number): void => {
    const abs = path.join(root, rel);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    if (rel && entries.some((e) => e.isFile() && e.name === '__manifest__.py')) {
      out.push({ name: path.basename(rel), dir: rel.replace(/\\/g, '/') });
      return;
    }
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(rel ? `${rel}/${e.name}` : e.name, depth + 1);
    }
  };
  walk('', 0);
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

/** Module directories from a `git ls-tree -r --name-only` listing (commit-accurate). */
export function modulesFromTree(files: string[]): ModuleInfo[] {
  return files
    .filter((f) => f.endsWith('/__manifest__.py'))
    .map((f) => {
      const dir = f.slice(0, -'/__manifest__.py'.length);
      return { name: dir.split('/').pop()!, dir };
    });
}

/** Top-level directories holding modules (moduleRoots); a module directly in the repo root yields []. */
export function moduleRootsFrom(mods: ModuleInfo[]): string[] {
  const roots = new Set<string>();
  for (const m of mods) {
    const parts = m.dir.split('/');
    if (parts.length === 1) return [];
    roots.add(parts[0]!);
  }
  return [...roots].sort();
}

/** Parent directories of modules — what an addons_path must list. '' = repository root. */
export function addonsDirsFrom(mods: ModuleInfo[]): string[] {
  return [...new Set(mods.map((m) => m.dir.split('/').slice(0, -1).join('/')))].sort();
}

const inRoots = (dir: string, roots: string[]): boolean => roots.length === 0 || roots.some((r) => dir === r || dir.startsWith(`${r}/`));

/** Module of a changed file: nearest parent directory with __manifest__.py inside moduleRoots (spec 8.7). */
export function moduleOfFile(file: string, moduleDirs: Map<string, ModuleInfo>, roots: string[]): ModuleInfo | null {
  const parts = file.split('/');
  for (let i = parts.length - 1; i > 0; i--) {
    const dir = parts.slice(0, i).join('/');
    const m = moduleDirs.get(dir);
    if (m) return inRoots(m.dir, roots) ? m : null;
  }
  return null;
}

export interface ChangedModulesResult {
  changed: ModuleInfo[];
  removed: ModuleInfo[];
}

/** Modules touched by a diff. Files of modules deleted in `to` are reported as removed (warning only). */
export function changedModules(files: string[], toModules: ModuleInfo[], fromModules: ModuleInfo[], roots: string[]): ChangedModulesResult {
  const toMap = new Map(toModules.map((m) => [m.dir, m]));
  const fromMap = new Map(fromModules.map((m) => [m.dir, m]));
  const changed = new Map<string, ModuleInfo>();
  const removed = new Map<string, ModuleInfo>();
  for (const f of files) {
    const m = moduleOfFile(f, toMap, roots);
    if (m) {
      changed.set(m.name, m);
      continue;
    }
    const old = moduleOfFile(f, fromMap, roots);
    if (old && !toModules.some((t) => t.name === old.name)) removed.set(old.name, old);
  }
  return { changed: [...changed.values()], removed: [...removed.values()] };
}

export interface ModuleActions {
  update: string[];
  install: string[];
  none: string[];
}

/**
 * Installed in the DB → `-u`; not installed but listed in modulesToInstall → `-i`; otherwise nothing (spec 8.7).
 */
export function splitInstallUpdate(modules: string[], installed: Set<string>, wanted: Set<string>): ModuleActions {
  const res: ModuleActions = { update: [], install: [], none: [] };
  for (const m of [...new Set(modules)].sort()) {
    if (installed.has(m)) res.update.push(m);
    else if (wanted.has(m)) res.install.push(m);
    else res.none.push(m);
  }
  return res;
}

/**
 * Modules whose tests run (spec 8.8): `changed` — modules changed by the build (8.7), `my` — modulesToInstall,
 * `{list}` — the list. `available` (modules installed in the tested database) filters the result when known.
 */
export function selectTestModules(
  mode: 'none' | 'changed' | 'my' | { list: string[] },
  input: { changed: string[]; wanted: Iterable<string>; available?: ReadonlySet<string> | null },
): string[] {
  const picked = mode === 'none' ? [] : mode === 'changed' ? input.changed : mode === 'my' ? [...input.wanted] : mode.list;
  return [...new Set(picked)].filter((m) => !input.available || input.available.has(m)).sort();
}

/** modules_to_install.txt: one module per line, `#` comments, commas allowed. */
export function parseModuleList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, ''))
    .flatMap((l) => l.split(','))
    .map((s) => s.trim())
    .filter((s) => /^[a-z0-9_]+$/.test(s));
}

/** `installedMatching: ['td_*', …]` filter over installed module names. */
export function matchInstalled(installed: Iterable<string>, patterns: string[]): string[] {
  const res = patterns.map(globToRegex);
  return [...installed].filter((n) => res.some((r) => r.test(n))).sort();
}

/** `version` from a manifest source (for updateModules: version-bumped). */
export function manifestVersion(src: string | null): string | null {
  if (!src) return null;
  const m = /['"]version['"]\s*:\s*['"]([^'"]+)['"]/.exec(src);
  return m ? m[1]! : null;
}
