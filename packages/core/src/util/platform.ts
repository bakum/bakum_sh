import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Host OS differences in one place (D67): Windows is the primary target, macOS (Apple Silicon) the second one. */
export const isWin = process.platform === 'win32';
export const isMac = process.platform === 'darwin';

/**
 * Docker engine socket. Windows: Docker Desktop's named pipe. macOS: DOCKER_HOST (unix://) if set, then the per-user
 * socket Docker Desktop always creates, then the default /var/run/docker.sock (only with «Allow the default Docker
 * socket»). BM_DOCKER_PIPE overrides it for the Docker-outage check (docs/acceptance.md, 14).
 */
export function dockerSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = fs.existsSync,
  home: string = os.homedir(),
): string {
  if (env.BM_DOCKER_PIPE) return env.BM_DOCKER_PIPE;
  if (platform === 'win32') return '//./pipe/docker_engine';
  const host = env.DOCKER_HOST;
  if (host?.startsWith('unix://')) return host.slice('unix://'.length);
  const user = path.posix.join(home, '.docker', 'run', 'docker.sock');
  return exists(user) ? user : '/var/run/docker.sock';
}

/**
 * Folders a macOS GUI app is missing in PATH: started from Finder / Dock it inherits only /usr/bin:/bin:/usr/sbin:/sbin,
 * so docker, Homebrew git / gh and the editors' shell commands would not be found.
 */
export function macExtraPath(home: string = os.homedir()): string[] {
  return ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/Applications/Docker.app/Contents/Resources/bin', path.posix.join(home, '.docker', 'bin')];
}

/** PATH with the missing folders appended (existing order wins). */
export function withExtraPath(current: string | undefined, extra: string[]): string {
  const parts = (current ?? '').split(':').filter(Boolean);
  for (const p of extra) if (!parts.includes(p)) parts.push(p);
  return parts.join(':');
}

/** POSIX shell quoting of one argument (macOS Terminal command line). */
export const shQuote = (a: string): string => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

/** `docker run … -e NAME …` (value taken from the environment) → `docker run --env-file <file> …`; other commands as is. */
export function dockerRunWithEnvFile(argv: string[], names: string[], file: string): string[] {
  if (argv[0] !== 'docker' || argv[1] !== 'run') return argv;
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-e' && names.includes(argv[i + 1] ?? '')) i++;
    else out.push(argv[i]!);
  }
  out.splice(2, 0, '--env-file', file);
  return out;
}
