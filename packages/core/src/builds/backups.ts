import fs from 'node:fs';
import path from 'node:path';
import type { BackupFile, ProjectConfig } from '@bm/shared';
import { globToRegex } from '../config/rules';
import { toPosix } from '../util/paths';

/** Production backups in backups.dir matching backups.pattern, newest first (spec 8.4). */
export function listBackups(cfg: ProjectConfig): BackupFile[] {
  const dir = cfg.production.backups.dir;
  if (!dir || !fs.existsSync(dir)) return [];
  const re = globToRegex(cfg.production.backups.pattern);
  return fs
    .readdirSync(dir)
    .filter((f) => re.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, path: toPosix(path.join(dir, f)), sizeBytes: st.size, mtime: st.mtime.toISOString() };
    })
    .filter((f) => f.sizeBytes > 0)
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

export function pickBackup(cfg: ProjectConfig): BackupFile | null {
  if (cfg.production.backups.pick === 'manual') return null;
  return listBackups(cfg)[0] ?? null;
}
