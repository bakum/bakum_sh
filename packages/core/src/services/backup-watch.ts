import path from 'node:path';
import fs from 'node:fs';
import chokidar, { type FSWatcher } from 'chokidar';
import { isLegacyProject, type ProjectConfig } from '@bm/shared';
import type { Ctx } from '../context';
import { globToRegex } from '../config/rules';
import { listBackups } from '../builds/backups';
import { requestBuildChecked } from '../builds/request';
import { branchByName } from './branch-rows';
import { notify } from './notify';
import { audit } from './audit';
import { bus } from '../events';
import { log } from '../util/logger';
import { t } from '../i18n';

/**
 * New production backups (spec 8.4): `production.backups.dir` of every enabled project is watched; a new file matching
 * `backups.pattern` gives the «найден новый бэкап» notification always, and with `backups.autoImport` an import.
 * Files already seen are kept in `kv backup-seen:<project>`: a file copied while the app was closed still counts as
 * new at the next start, and the first watch of a folder takes its current files as known.
 */
export class BackupWatcher {
  private watchers = new Map<string, { watcher: FSWatcher; key: string }>();

  constructor(private readonly ctx: Ctx) {}

  /** (Re)starts the watchers after a start or a settings change. */
  sync(): void {
    const want = new Map<string, { cfg: ProjectConfig; key: string }>();
    for (const e of this.ctx.store.list()) {
      const cfg = e.config;
      if (!cfg || !cfg.enabled || isLegacyProject(cfg)) continue;
      const dir = cfg.production.backups.dir;
      if (!dir || !fs.existsSync(dir)) continue;
      want.set(cfg.id, { cfg, key: `${path.resolve(dir)}|${cfg.production.backups.pattern}` });
    }
    for (const [id, w] of this.watchers) {
      if (want.get(id)?.key !== w.key) {
        void w.watcher.close();
        this.watchers.delete(id);
      }
    }
    for (const [id, { cfg, key }] of want) {
      if (this.watchers.has(id)) continue;
      const seen = this.loadSeen(id);
      const current = listBackups(cfg);
      if (seen === null) this.saveSeen(id, current.map((f) => f.name));
      else for (const f of current.filter((x) => !seen.has(x.name)).reverse()) this.found(id, f.path);
      const watcher = chokidar.watch(cfg.production.backups.dir!, {
        depth: 0,
        ignoreInitial: true,
        // A backup is copied for minutes: it counts once its size has not changed for 10 s.
        awaitWriteFinish: { stabilityThreshold: 10_000, pollInterval: 2000 },
      });
      watcher.on('add', (file) => this.found(id, file));
      watcher.on('error', (err) => log().warn({ err, project: id }, 'backup watcher error'));
      this.watchers.set(id, { watcher, key });
    }
  }

  stop(): void {
    for (const w of this.watchers.values()) void w.watcher.close();
    this.watchers.clear();
  }

  private loadSeen(id: string): Set<string> | null {
    const row = this.ctx.sqlite.prepare('SELECT value FROM kv WHERE key = ?').get(`backup-seen:${id}`) as { value: string } | undefined;
    if (!row) return null;
    try {
      return new Set(JSON.parse(row.value) as string[]);
    } catch {
      return new Set();
    }
  }

  private saveSeen(id: string, names: string[]): void {
    this.ctx.sqlite.prepare('INSERT OR REPLACE INTO kv(key, value) VALUES (?, ?)').run(`backup-seen:${id}`, JSON.stringify([...new Set(names)]));
  }

  private found(id: string, file: string): void {
    const cfg = this.ctx.store.get(id)?.config;
    if (!cfg) return;
    const name = path.basename(file);
    if (!globToRegex(cfg.production.backups.pattern).test(name)) return;
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) return;
    const seen = this.loadSeen(id) ?? new Set<string>();
    if (seen.has(name)) return;
    // Only files still in the folder are remembered: the list does not grow forever.
    const present = new Set(listBackups(cfg).map((f) => f.name));
    this.saveSeen(id, [...[...seen].filter((n) => present.has(n)), name]);
    log().info({ project: id, file: name }, 'new production backup');
    audit(this.ctx, { projectId: id, action: 'backup.found', target: name, params: { autoImport: cfg.production.backups.autoImport } });
    const prod = branchByName(this.ctx, id, cfg.production.branch);
    notify(
      this.ctx,
      'newBackup',
      t('backup.foundTitle', { project: cfg.name }),
      t(cfg.production.backups.autoImport ? 'backup.importStarted' : 'backup.importInTab', { name }),
      { route: prod ? `/projects/${id}/branches/${prod.id}/backups` : `/projects/${id}/branches` },
    );
    bus.emit({ type: 'project.changed', projectId: id });
    if (!cfg.production.backups.autoImport || !prod) return;
    requestBuildChecked(this.ctx, prod.id, { trigger: 'import_backup', kind: 'new', backupPath: file.replace(/\\/g, '/') }).catch((err) => {
      log().warn({ err, project: id, file: name }, 'backup auto-import failed');
      audit(this.ctx, { projectId: id, action: 'backup.autoImport', target: name, result: 'failed', params: { error: (err as Error).message } });
      notify(this.ctx, 'buildFailed', t('backup.autoImportFailed', { project: cfg.name }), `${name}: ${(err as Error).message}`, {
        route: `/projects/${id}/branches/${prod.id}/backups`,
      });
    });
  }
}
