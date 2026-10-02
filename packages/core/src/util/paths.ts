import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Expands %VAR% (Windows style) and a leading ~ in a configured path, returns a normalized absolute path. */
export function expandPath(p: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = p.replace(/%([A-Za-z0-9_]+)%/g, (_, name: string) => {
    const v = env[name] ?? env[name.toUpperCase()];
    if (v === undefined) throw new Error(`Переменная окружения %${name}% не задана (путь «${p}»)`);
    return v;
  });
  if (out.startsWith('~')) out = path.join(os.homedir(), out.slice(1));
  return path.resolve(out);
}

/** Forward-slash form used in YAML and docker bind mounts. */
export const toPosix = (p: string): string => p.replace(/\\/g, '/');

/**
 * Absolute path for comparisons. On macOS symlinks are resolved (git and Docker report /private/var/… for /var/…,
 * D67); a path that does not exist yet keeps its missing tail under the resolved existing ancestor. Windows keeps the
 * plain resolve: junctions and 8.3 names were never expanded there and the safety checks rely on that.
 */
function canonical(p: string): string {
  const abs = path.resolve(p);
  if (process.platform === 'win32') return abs;
  let head = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(head), ...tail);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return abs;
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

/** Case-insensitive (Windows, default APFS) containment check: is `child` strictly inside `parent`? */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(canonical(parent).toLowerCase(), canonical(child).toLowerCase());
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function samePath(a: string, b: string): boolean {
  return canonical(a).toLowerCase() === canonical(b).toLowerCase();
}
