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

/** Case-insensitive (Windows) containment check: is `child` strictly inside `parent`? */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent).toLowerCase(), path.resolve(child).toLowerCase());
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}
