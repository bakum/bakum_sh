import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The app's command line (D53): the named pipe Core listens on and the launchers in `<localDir>/bin`, rewritten on
 * every start so they point at the running exe (an installed copy moves on update, a portable one runs from a temp
 * folder). `bm.cmd` — cmd / PowerShell, `bm` — Git Bash (Windows) or any POSIX shell (macOS); both run cli.js with the
 * exe as plain Node.
 */
export function cliPipeName(profile: string): string {
  const user = (os.userInfo().username || 'user').replace(/[^A-Za-z0-9_.-]/g, '_');
  const name = `odoo-branch-manager-${user}${profile ? `-${profile}` : ''}`;
  // macOS (D67): a unix socket in the per-user temp folder — short (sun_path is 104 bytes) and without spaces.
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
}

const msysPath = (p: string): string => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);

export function installCliLaunchers(o: { binDir: string; pipe: string; exe: string; cliJs: string }): void {
  fs.mkdirSync(o.binDir, { recursive: true });
  fs.copyFileSync(o.cliJs, path.join(o.binDir, 'cli.js'));
  const cmd = [
    '@echo off',
    'rem Odoo Branch Manager command line (bm help). Written by the app on every start: do not edit.',
    'setlocal',
    'set "ELECTRON_RUN_AS_NODE=1"',
    `set "BM_PIPE=${o.pipe}"`,
    `"${o.exe}" "%~dp0cli.js" %*`,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
  const sh = [
    '#!/bin/sh',
    '# Odoo Branch Manager command line (bm help). Written by the app on every start: do not edit.',
    `ELECTRON_RUN_AS_NODE=1 BM_PIPE='${o.pipe}' exec "${msysPath(o.exe)}" "$(dirname "$0")/cli.js" "$@"`,
    '',
  ].join('\n');
  if (process.platform === 'win32') fs.writeFileSync(path.join(o.binDir, 'bm.cmd'), cmd, 'utf8');
  fs.writeFileSync(path.join(o.binDir, 'bm'), sh, { encoding: 'utf8', mode: 0o755 });
}
