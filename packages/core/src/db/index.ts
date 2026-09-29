import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export type Db = BetterSQLite3Database<typeof schema>;

/** Schema migrations, applied in order; `PRAGMA user_version` holds the applied count. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, config_path TEXT NOT NULL, repo_path TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_fetch_at TEXT, last_fetch_error TEXT, config_hash TEXT
  );
  CREATE TABLE branches (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL,
    stage TEXT NOT NULL, assigned_by TEXT NOT NULL, worktree_path TEXT, worktree_tracking TEXT,
    overrides TEXT NOT NULL DEFAULT '{}', last_seen_remote_sha TEXT, last_seen_local_sha TEXT, paused_reason TEXT,
    stage_changed_at TEXT, last_active_at TEXT, created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX branches_project_name ON branches(project_id, name);
  CREATE UNIQUE INDEX branches_project_slug ON branches(project_id, slug);
  CREATE TABLE builds (
    id INTEGER PRIMARY KEY AUTOINCREMENT, branch_id INTEGER NOT NULL, project_id TEXT NOT NULL, number INTEGER NOT NULL,
    stage TEXT NOT NULL, commit_sha TEXT, commits TEXT NOT NULL DEFAULT '[]', "trigger" TEXT NOT NULL, kind TEXT NOT NULL,
    db_source TEXT NOT NULL, db_name TEXT NOT NULL, host TEXT NOT NULL, compose_project TEXT NOT NULL, debug_port INTEGER,
    status TEXT NOT NULL, tests TEXT, steps TEXT NOT NULL DEFAULT '[]', log_path TEXT, config_hash TEXT,
    source_build_id INTEGER, previous_build_id INTEGER, live INTEGER NOT NULL DEFAULT 0,
    created_resources TEXT NOT NULL DEFAULT '{}', source_mirror_build_id INTEGER,
    created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, dropped_at TEXT, error_message TEXT
  );
  CREATE INDEX builds_branch ON builds(branch_id, number);
  CREATE INDEX builds_project ON builds(project_id, created_at);
  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, status TEXT NOT NULL, project_id TEXT, branch_id INTEGER,
    build_id INTEGER, params TEXT NOT NULL DEFAULT '{}', error TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
  );
  CREATE INDEX jobs_status ON jobs(status);
  CREATE TABLE snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, build_id INTEGER NOT NULL, name TEXT NOT NULL, db_name TEXT NOT NULL,
    filestore_path TEXT, size_bytes INTEGER, created_at TEXT NOT NULL
  );
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, at TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '{}', result TEXT NOT NULL, diff TEXT
  );
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  // D37: Staging is gone — its branches and builds become Development; branches can be hidden from the sidebar.
  `
  UPDATE branches SET stage = 'development' WHERE stage = 'staging';
  UPDATE builds SET stage = 'development' WHERE stage = 'staging';
  ALTER TABLE branches ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
  `,
];

export function openDb(file: string): { db: Db; sqlite: Database.Database } {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const version = sqlite.pragma('user_version', { simple: true }) as number;
  for (let i = version; i < MIGRATIONS.length; i++) {
    sqlite.transaction(() => {
      sqlite.exec(MIGRATIONS[i]!);
      sqlite.pragma(`user_version = ${i + 1}`);
    })();
  }
  return { db: drizzle(sqlite, { schema }), sqlite };
}

export { schema };
