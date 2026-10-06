import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { BuildStep, CommitInfo, TestsResult, BranchScope } from '@bm/shared';
import type { CodeState, TestedCode } from '../builds/code-state';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  configPath: text('config_path').notNull(),
  repoPath: text('repo_path').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
  lastFetchAt: text('last_fetch_at'),
  lastFetchError: text('last_fetch_error'),
  configHash: text('config_hash'),
});

export const branches = sqliteTable(
  'branches',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: text('project_id').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    stage: text('stage', { enum: ['production', 'development'] }).notNull(),
    assignedBy: text('assigned_by', { enum: ['user', 'rule'] }).notNull(),
    worktreePath: text('worktree_path'),
    /** Tracking mode the worktree was created with (the effective setting may change later). */
    worktreeTracking: text('worktree_tracking', { enum: ['local', 'remote'] }),
    overrides: text('overrides', { mode: 'json' }).$type<BranchScope>().notNull().default({}),
    lastSeenRemoteSha: text('last_seen_remote_sha'),
    lastSeenLocalSha: text('last_seen_local_sha'),
    pausedReason: text('paused_reason'),
    stageChangedAt: text('stage_changed_at'),
    lastActiveAt: text('last_active_at'),
    createdAt: text('created_at').notNull(),
    hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [uniqueIndex('branches_project_name').on(t.projectId, t.name), uniqueIndex('branches_project_slug').on(t.projectId, t.slug)],
);

export const builds = sqliteTable('builds', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  branchId: integer('branch_id').notNull(),
  projectId: text('project_id').notNull(),
  number: integer('number').notNull(),
  stage: text('stage', { enum: ['production', 'development'] }).notNull(),
  commitSha: text('commit_sha'),
  commits: text('commits', { mode: 'json' }).$type<CommitInfo[]>().notNull().default([]),
  trigger: text('trigger', { enum: ['new_commit', 'rebuild', 'manual', 'import_backup', 'stage_change'] }).notNull(),
  kind: text('kind', { enum: ['new', 'update'] }).notNull(),
  dbSource: text('db_source').notNull(),
  dbName: text('db_name').notNull(),
  host: text('host').notNull(),
  composeProject: text('compose_project').notNull(),
  debugPort: integer('debug_port'),
  status: text('status', { enum: ['queued', 'building', 'running', 'stopped', 'failed', 'dropped'] }).notNull(),
  tests: text('tests', { mode: 'json' }).$type<TestsResult | null>(),
  /** Builds from the user's folder (D76): code the database was brought to, per module (manual -u included). */
  codeState: text('code_state', { mode: 'json' }).$type<CodeState | null>(),
  /** Builds from the user's folder (D76): code the result in `tests` was obtained on. */
  testedCode: text('tested_code', { mode: 'json' }).$type<TestedCode | null>(),
  steps: text('steps', { mode: 'json' }).$type<BuildStep[]>().notNull().default([]),
  logPath: text('log_path'),
  configHash: text('config_hash'),
  /** For copies: the build whose database was copied (8.7 diff base). */
  sourceBuildId: integer('source_build_id'),
  /** For `update` builds: the build this one replaced; it shares the database. */
  previousBuildId: integer('previous_build_id'),
  /** Set when the new/update build is the branch's live one. */
  live: integer('live', { mode: 'boolean' }).notNull().default(false),
  /** Resources actually created by this build (for clean "Отбросить"). */
  createdResources: text('created_resources', { mode: 'json' }).$type<{ db?: boolean; filestore?: boolean; compose?: boolean }>().notNull().default({}),
  sourceMirrorBuildId: integer('source_mirror_build_id'),
  createdAt: text('created_at').notNull(),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
  droppedAt: text('dropped_at'),
  errorMessage: text('error_message'),
});

export const jobs = sqliteTable('jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(),
  status: text('status', { enum: ['queued', 'running', 'success', 'failed', 'cancelled', 'interrupted'] }).notNull(),
  projectId: text('project_id'),
  branchId: integer('branch_id'),
  buildId: integer('build_id'),
  params: text('params', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
});

export const snapshots = sqliteTable('snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  buildId: integer('build_id').notNull(),
  name: text('name').notNull(),
  dbName: text('db_name').notNull(),
  filestorePath: text('filestore_path'),
  sizeBytes: integer('size_bytes'),
  createdAt: text('created_at').notNull(),
});

export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: text('project_id'),
  at: text('at').notNull(),
  action: text('action').notNull(),
  target: text('target').notNull(),
  params: text('params', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  result: text('result').notNull(),
  diff: text('diff'),
});

export const kv = sqliteTable('kv', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export type ProjectRow = typeof projects.$inferSelect;
export type BranchRow = typeof branches.$inferSelect;
export type BuildRow = typeof builds.$inferSelect;
export type SnapshotRow = typeof snapshots.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
