import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Version, commit and build date baked into main and renderer (docs/decisions.md D27). */
export function buildInfo(): Record<string, string> {
  const version = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')).version as string;
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    // Only changes to tracked files count: electron-vite puts a temporary bundled config next to the real one.
    if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()) commit += '-dirty';
  } catch {
    /* building outside a git checkout */
  }
  return {
    __BM_VERSION__: JSON.stringify(version),
    __BM_COMMIT__: JSON.stringify(commit),
    __BM_BUILD_DATE__: JSON.stringify(new Date().toISOString()),
  };
}
