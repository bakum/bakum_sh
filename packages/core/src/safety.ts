import path from 'node:path';
import { BmError, type ProjectConfig } from '@bm/shared';
import { SQL_IDENT_RE, templateToRegex } from './config/templates';
import { isInside, samePath } from './util/paths';
import { t } from './i18n';

/** Names the registry (SQLite) knows as created by the app. */
export interface OwnedRegistry {
  dbNames: ReadonlySet<string>;
  composeProjects: ReadonlySet<string>;
  worktrees: ReadonlySet<string>;
}

export type OwnedResource =
  | { kind: 'db'; name: string }
  | { kind: 'container'; name: string; labels: Record<string, string> }
  | { kind: 'compose'; name: string }
  | { kind: 'worktree'; path: string }
  /** The app's bare mirror of the project repository (D33), removed only together with the project. */
  | { kind: 'mirror'; path: string; reposRoot: string }
  | { kind: 'filestore'; path: string; db: string }
  /** An anonymous volume (image VOLUME) of a build container, removed with the container (D55). */
  | { kind: 'volume'; name: string; anonymous: boolean; container: { name: string; labels: Record<string, string> } };

const SYSTEM_DBS = new Set(['postgres', 'template0', 'template1']);

/**
 * The only gate in front of destructive calls (drop DB, rm container / compose project, remove worktree, rm filestore).
 * A resource must look like the app's own (template, labels, location) AND be recorded in the registry,
 * and must not be on a protected list. Throws a user-facing error otherwise.
 */
export function assertOwned(cfg: ProjectConfig, r: OwnedResource, reg: OwnedRegistry): void {
  const deny = (why: string): never => {
    throw new BmError('NOT_OWNED', t('safety.denied', { why }), r);
  };
  switch (r.kind) {
    case 'db': {
      if (!SQL_IDENT_RE.test(r.name)) deny(t('safety.badDbName', { name: r.name }));
      if (SYSTEM_DBS.has(r.name) || cfg.postgres.protectedDbs.includes(r.name)) deny(t('safety.dbProtected', { name: r.name }));
      const re = templateToRegex(cfg.naming.db.replace('{project}', cfg.id));
      // Temporary test copies (<db>_test) and snapshots (<db>_snap_<n>) derive from a build DB name.
      const base = r.name.replace(/(_test|_snap_\d+)$/, '');
      if (!re.test(r.name) && !re.test(base)) deny(t('safety.dbTemplate', { name: r.name, id: cfg.id }));
      if (!reg.dbNames.has(r.name)) deny(t('safety.dbNotRegistered', { name: r.name }));
      return;
    }
    case 'container': {
      if (cfg.postgres.protectedContainers.includes(r.name.replace(/^\//, ''))) deny(t('safety.containerProtected', { name: r.name }));
      if (r.labels['bm.project'] !== cfg.id) deny(t('safety.noLabel', { name: r.name, id: cfg.id }));
      return;
    }
    case 'compose': {
      const re = templateToRegex(cfg.naming.composeProject.replace('{project}', cfg.id));
      if (!re.test(r.name)) deny(t('safety.composeTemplate', { name: r.name }));
      if (!reg.composeProjects.has(r.name)) deny(t('safety.composeNotRegistered', { name: r.name }));
      return;
    }
    case 'worktree': {
      if (!isInside(cfg.repo.worktreesDir, r.path)) deny(t('safety.worktreeOutside', { path: r.path, dir: cfg.repo.worktreesDir }));
      // Neither the repository nor the user's folder may be the worktree, lie inside it or contain it.
      const overlaps = (own: string | null | undefined): boolean => !!own && (samePath(r.path, own) || isInside(r.path, own) || isInside(own, r.path));
      if (overlaps(cfg.repo.path) || overlaps(cfg.repo.mirrorDir)) deny(t('safety.projectRepo'));
      if (overlaps(cfg.repo.localFolder)) deny(t('safety.yourFolder'));
      if (![...reg.worktrees].some((w) => samePath(w, r.path))) deny(t('safety.worktreeNotRegistered', { path: r.path }));
      return;
    }
    case 'mirror': {
      if (!cfg.repo.mirrorDir || !samePath(r.path, cfg.repo.mirrorDir)) deny(t('safety.notMirror', { path: r.path, id: cfg.id }));
      if (!isInside(r.reposRoot, r.path)) deny(t('safety.mirrorOutside', { path: r.path, root: r.reposRoot }));
      if (cfg.repo.localFolder && samePath(r.path, cfg.repo.localFolder)) deny(t('safety.yourFolder'));
      return;
    }
    case 'filestore': {
      assertOwned(cfg, { kind: 'db', name: r.db }, reg);
      const expected = path.join(cfg.runtime.filestore.hostDir, r.db);
      if (!samePath(expected, r.path)) deny(t('safety.notFilestore', { path: r.path, db: r.db }));
      return;
    }
    case 'volume': {
      // Named volumes (the managed Postgres data, the user's own) are never removed this way.
      if (!r.anonymous) deny(t('safety.volumeNamed', { name: r.name }));
      assertOwned(cfg, { kind: 'container', ...r.container }, reg);
      return;
    }
  }
}
