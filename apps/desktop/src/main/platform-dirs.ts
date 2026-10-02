import os from 'node:os';
import path from 'node:path';

/**
 * Roots of the configuration folder and of the data folder (registry, logs, mirrors, compose files).
 * Windows: %APPDATA% and %LOCALAPPDATA%. macOS (D67): ~/Library/Application Support for the YAML settings and the XDG
 * data home (~/.local/share) for the data — two roots, so `projects/<id>.yaml` and `projects/<id>/branches/` never share
 * a folder; Core gets them as APPDATA / LOCALAPPDATA, so `%LOCALAPPDATA%` in app.yaml means the same on both systems.
 */
export function dirRoots(appData: string, env: NodeJS.ProcessEnv = process.env): { configRoot: string; localRoot: string } {
  if (process.platform === 'darwin') {
    return { configRoot: appData, localRoot: env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share') };
  }
  return { configRoot: env.APPDATA ?? appData, localRoot: env.LOCALAPPDATA ?? appData };
}
