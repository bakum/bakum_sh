/**
 * IPC contract between renderer / main and Core (spec section 10).
 * Params are zod schemas and are validated inside Core; results are typed via phantom generics.
 */
import { z } from 'zod';
import { branchScopeSchema, levelSchema, stageSchema, type ProjectConfig, type AppConfig } from './config';
import type {
  AppStateView,
  AuditList,
  BackupFile,
  BranchesList,
  BranchView,
  BuildView,
  ChangedModules,
  DetectResult,
  EffectiveConfig,
  GitBranchInfo,
  JobView,
  ProjectSummary,
  MonitorView,
  RepoProbe,
  SnapshotView,
  SystemStatus,
  UnassignedBranch,
} from './types';

interface MethodDef<P extends z.ZodType, R> {
  params: P;
  /** phantom, never set */
  result?: R;
}
function m<R>() {
  return <P extends z.ZodType>(params: P): MethodDef<P, R> => ({ params });
}

const empty = z.object({}).strict();
const projectId = z.string().regex(/^[a-z0-9-]+$/);
const id = z.number().int().positive();
const isoTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/, 'ожидается время ISO в UTC');
/**
 * https://host/owner/repo(.git), git@host:owner/repo(.git), ssh://… or file:///<disk>/<path> (a local or network bare
 * repository); no credentials inside the URL except a user name.
 */
const repoUrl = z
  .string()
  .trim()
  .regex(
    /^(https:\/\/([\w.-]+@)?[\w.-]+(:\d+)?\/[\w./~-]+|ssh:\/\/[\w.-]+@[\w.-]+(:\d+)?\/[\w./~-]+|[\w.-]+@[\w.-]+:[\w./~-]+|file:\/\/\/?[\w.:/~ -]+)$/,
    'ожидается https://…, git@…:owner/repo.git или file:///…',
  );

/** Everything «Удалить проект…» removes (full cleanup, D34). */
export interface ProjectDeletePreview {
  legacy: boolean;
  builds: string[];
  databases: string[];
  filestores: string[];
  worktrees: string[];
  postgres: string | null;
  /** The Odoo image the app built (runtime.build, D46); removed only if it carries the project's label. */
  image: string | null;
  /** The app's mirror, project folder in dataDir, build and job logs, the settings file. */
  folders: string[];
  settingsFile: string;
  /** Registry rows removed: jobs, audit records, auto-add exclusions. */
  registry: { jobs: number; audit: number; kv: number };
}

/** What «Перевести на свой Postgres» does for a project on an external Postgres. */
export interface PgMigratePreview {
  /** Why the move is impossible now (not external, Docker down…); null — it can start. */
  blocker: string | null;
  source: { host: string; port: number; container: string | null; version: string | null; error: string | null };
  target: { container: string; image: string; port: number | null; network: string };
  /** Databases of the project's builds (test copies and snapshots included) copied with pg_dump / pg_restore. */
  databases: { name: string; sizeBytes: number | null }[];
  /** Live builds recreated in the new network; running ones are stopped for the copy. */
  builds: string[];
}

export interface JobRef {
  jobId: number;
}

export const shellTargets = [
  'browser',
  'browser-debug',
  'explorer',
  'editor',
  'editor-cursor',
  'terminal',
  'bash',
  'odoo-shell',
  'psql',
  'mails',
  'github',
  'build-log',
  'logs-dir',
] as const;

export const methods = {
  'system.ping': m<{ pong: true; pid: number; startedAt: string }>()(empty),
  'system.state': m<AppStateView>()(empty),
  'system.status': m<SystemStatus>()(z.object({ refresh: z.boolean().optional() }).strict()),
  'system.completeFirstRun': m<{ ok: true }>()(z.object({ proxyPort: z.number().int().optional() }).strict()),
  'system.startDocker': m<{ ok: true }>()(empty),
  'system.cleanupOrphans': m<{ removed: number; errors: string[] }>()(
    z.object({ items: z.array(z.object({ kind: z.string(), name: z.string(), projectId: z.string().nullable() })) }).strict(),
  ),

  'projects.list': m<ProjectSummary[]>()(empty),
  'projects.get': m<{ summary: ProjectSummary; config: ProjectConfig; yaml: string }>()(
    z.object({ projectId }).strict(),
  ),
  'projects.detect': m<DetectResult>()(
    z
      .object({
        /** The app's mirror made by the `repo.clone` job (mirror: true), its URL and optionally the user's own clone. */
        mirror: z.string().min(1),
        url: repoUrl,
        folder: z.string().min(1).nullable().optional(),
        /** Choices of the «Odoo in Docker» preset made in the wizard. */
        odoo: z.object({ version: z.string().regex(/^\d+\.\d+$/).optional(), enterprisePath: z.string().nullable().optional() }).strict().optional(),
      })
      .strict(),
  ),
  'projects.create': m<ProjectSummary>()(z.object({ yaml: z.string().min(1) }).strict()),
  /** Connection check of an external Postgres before the project is created (the detected password is used). */
  'projects.checkPostgres': m<{ ok: boolean; text: string }>()(z.object({ yaml: z.string().min(1) }).strict()),
  'projects.update': m<ProjectSummary>()(z.object({ projectId, yaml: z.string().min(1) }).strict()),
  'projects.setEnabled': m<ProjectSummary>()(z.object({ projectId, enabled: z.boolean() }).strict()),
  'projects.deletePreview': m<ProjectDeletePreview>()(
    z.object({ projectId }).strict(),
  ),
  'projects.delete': m<JobRef>()(z.object({ projectId, confirm: z.string() }).strict()),
  /** External Postgres → the app's own container (postgres.mode: managed) with the databases of the builds. */
  'projects.pgMigratePreview': m<PgMigratePreview>()(z.object({ projectId }).strict()),
  'projects.pgMigrate': m<JobRef>()(z.object({ projectId }).strict()),
  /** `docker build` of runtime.build now (D46): checks the Dockerfile before a build needs the image. */
  'projects.buildImage': m<JobRef>()(z.object({ projectId }).strict()),

  'config.get': m<{ yaml: string; value: unknown }>()(
    z.object({ projectId: projectId.optional(), level: levelSchema, branchId: id.optional() }).strict(),
  ),
  'config.put': m<{ ok: true }>()(
    z.object({ projectId: projectId.optional(), level: levelSchema, branchId: id.optional(), yaml: z.string() }).strict(),
  ),
  'config.effective': m<EffectiveConfig>()(z.object({ branchId: id }).strict()),
  'config.jsonSchema': m<{ project: unknown; app: unknown; branch: unknown }>()(empty),
  'config.app': m<AppConfig>()(empty),

  'branches.list': m<BranchesList>()(z.object({ projectId }).strict()),
  'branches.get': m<BranchView>()(z.object({ branchId: id }).strict()),
  'branches.gitList': m<GitBranchInfo[]>()(z.object({ projectId }).strict()),
  'branches.add': m<BranchView>()(
    z.object({ projectId, name: z.string().min(1), stage: stageSchema.optional(), build: z.boolean().optional() }).strict(),
  ),
  'branches.setStage': m<BranchView>()(z.object({ branchId: id, stage: stageSchema }).strict()),
  'branches.resetToRule': m<BranchView>()(z.object({ branchId: id }).strict()),
  'branches.setHidden': m<BranchView>()(z.object({ branchId: id, hidden: z.boolean() }).strict()),
  'branches.setOverrides': m<BranchView>()(z.object({ branchId: id, overrides: branchScopeSchema }).strict()),
  'branches.fork': m<{ branch: BranchView; jobId: number | null }>()(
    z.object({ branchId: id, name: z.string().min(1) }).strict(),
  ),
  'branches.forkName': m<{ name: string; base: string; valid: boolean; error: string | null }>()(
    z.object({ projectId, name: z.string() }).strict(),
  ),
  'branches.merge': m<{ url: string }>()(z.object({ sourceId: id, targetId: id }).strict()),
  'branches.deletePreview': m<{ dirty: string | null; builds: number; canDeleteRemote: boolean; protected: boolean }>()(
    z.object({ branchId: id }).strict(),
  ),
  'branches.delete': m<JobRef>()(
    z
      .object({
        branchId: id,
        confirmSlug: z.string(),
        deleteRemote: z.boolean().default(false),
        forceDirty: z.boolean().default(false),
      })
      .strict(),
  ),
  'branches.preview': m<UnassignedBranch>()(z.object({ projectId, branch: z.string().min(1) }).strict()),
  'branches.ensureWorktree': m<{ path: string }>()(z.object({ branchId: id }).strict()),

  'builds.list': m<{ items: BuildView[]; total: number }>()(
    z
      .object({
        projectId: projectId.optional(),
        branchId: id.optional(),
        stage: stageSchema.optional(),
        status: z.enum(['queued', 'building', 'running', 'stopped', 'failed', 'dropped']).optional(),
        trigger: z.enum(['new_commit', 'rebuild', 'manual', 'import_backup', 'stage_change']).optional(),
        /** failed — failed or errored tests, passed — tests ran without failures, none — tests did not run. */
        tests: z.enum(['failed', 'passed', 'none']).optional(),
        /** Builds created at or after / before these ISO times. */
        since: isoTime.optional(),
        until: isoTime.optional(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(200).default(20),
      })
      .strict(),
  ),
  'builds.get': m<BuildView>()(z.object({ buildId: id }).strict()),
  'builds.rebuild': m<JobRef>()(
    z.object({ branchId: id, trigger: z.enum(['rebuild', 'stage_change', 'manual']).optional() }).strict(),
  ),
  'builds.update': m<JobRef>()(z.object({ branchId: id }).strict()),
  'builds.retry': m<JobRef>()(z.object({ buildId: id, fromStep: z.string() }).strict()),
  'builds.drop': m<JobRef>()(z.object({ buildId: id }).strict()),
  'builds.action': m<JobRef>()(
    z.object({ buildId: id, action: z.enum(['start', 'stop', 'restart', 'apply-config']) }).strict(),
  ),
  'builds.stopAll': m<{ jobs: number }>()(empty),
  'builds.changedModules': m<ChangedModules>()(z.object({ branchId: id }).strict()),
  'builds.launchJson': m<{ json: string; debugPort: number | null }>()(z.object({ buildId: id }).strict()),
  'builds.writeLaunchJson': m<{ path: string; gitignoreWarning: boolean }>()(z.object({ buildId: id }).strict()),
  'builds.credentials': m<{ login: string | null; password: string | null; url: string | null }>()(
    z.object({ buildId: id }).strict(),
  ),
  'builds.connectionString': m<{ value: string }>()(z.object({ buildId: id }).strict()),
  'builds.resetAdminPassword': m<{ ok: true }>()(z.object({ buildId: id }).strict()),
  'builds.modulesAction': m<JobRef>()(
    z
      .object({ buildId: id, install: z.array(z.string().regex(/^[a-z0-9_]+$/)), update: z.array(z.string().regex(/^[a-z0-9_]+$/)) })
      .strict(),
  ),

  'backups.list': m<BackupFile[]>()(z.object({ projectId }).strict()),
  'backups.import': m<JobRef>()(z.object({ projectId, path: z.string().min(1) }).strict()),

  'monitor.get': m<MonitorView>()(z.object({ buildId: id }).strict()),

  /** Snapshots of the live build's database (spec 8.9 Backups). */
  'snapshots.list': m<SnapshotView[]>()(z.object({ branchId: id }).strict()),
  'snapshots.create': m<JobRef>()(z.object({ branchId: id, name: z.string().trim().max(80).optional() }).strict()),
  'snapshots.restore': m<JobRef>()(z.object({ snapshotId: id }).strict()),
  'snapshots.delete': m<JobRef>()(z.object({ snapshotId: id }).strict()),
  /** Odoo backup `.zip` (`odoo db dump`) of the live database or of a snapshot, written to `path` (chosen in a dialog). */
  'snapshots.export': m<JobRef>()(z.object({ branchId: id, snapshotId: id.optional(), path: z.string().min(1).regex(/\.zip$/i, 'нужен файл .zip') }).strict()),

  'git.fetch': m<{ jobs: number[] }>()(z.object({ projectId: projectId.optional() }).strict()),

  /** Remote repository access (docs/decisions.md D31). Credentials stay in the Git credential helper. */
  'repo.probe': m<RepoProbe>()(z.object({ url: repoUrl }).strict()),
  /** Same check with the credential helper allowed to show its sign-in window (Git Credential Manager). */
  'repo.login': m<RepoProbe>()(z.object({ url: repoUrl }).strict()),
  /** Hands a personal access token to `git credential approve` (stored by the helper, e.g. Windows Credential Manager). */
  'repo.saveToken': m<RepoProbe>()(
    z.object({ url: repoUrl, username: z.string().regex(/^[\w.@-]+$/).default('x-access-token'), token: z.string().min(8).max(500) }).strict(),
  ),
  /** Sign-in for an existing project (its remote URL), then a fetch. */
  'projects.login': m<RepoProbe>()(z.object({ projectId }).strict()),
  /** Remote URL of the user's own clone (read-only), to start a project from a folder. */
  'repo.folderRemote': m<{ top: string; remote: string | null; url: string | null }>()(z.object({ path: z.string().min(1) }).strict()),
  'repo.defaultDir': m<{ dir: string }>()(z.object({ url: repoUrl, suffix: z.string().regex(/^[\w.-]*$/).optional() }).strict()),
  /** `mirror` — the app's own bare copy of the project repository in `<dataDir>/repos` (D33, `dir` is chosen by Core). */
  'repo.clone': m<JobRef & { dir: string }>()(
    z
      .object({
        url: repoUrl,
        mirror: z.boolean().default(false),
        dir: z.string().min(3).optional(),
        /** Single branch, shallow (Enterprise addons of one Odoo series). */
        branch: z.string().regex(/^[\w./-]+$/).optional(),
        shallow: z.boolean().default(false),
      })
      .strict(),
  ),

  'jobs.list': m<JobView[]>()(
    z.object({ projectId: projectId.optional(), active: z.boolean().optional(), limit: z.number().int().optional() }).strict(),
  ),
  'jobs.get': m<JobView>()(z.object({ jobId: id }).strict()),
  'jobs.cancel': m<{ ok: true }>()(z.object({ jobId: id }).strict()),
  'jobs.log': m<{ lines: string[] }>()(z.object({ jobId: id, tail: z.number().int().min(1).max(2000).default(200) }).strict()),

  'audit.list': m<AuditList>()(
    z
      .object({
        projectId: projectId.optional(),
        /** With a project: also the app-level records (app.yaml, updates). */
        withApp: z.boolean().default(false),
        /** Exact action (`build.success`) or a group prefix ending with a dot (`build.`). */
        action: z.string().max(100).optional(),
        /** Case-insensitive text in the target or the parameters. */
        q: z.string().max(200).optional(),
        result: z.enum(['ok', 'error']).optional(),
        since: isoTime.optional(),
        until: isoTime.optional(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(500).default(50),
      })
      .strict(),
  ),

  'logs.read': m<{ lines: string[]; path: string | null }>()(
    z.object({ buildId: id, kind: z.enum(['build', 'tests', 'odoo']), tail: z.number().int().optional() }).strict(),
  ),

  'shell.open': m<{ ok: true; detail?: string }>()(
    z.object({ buildId: id.optional(), branchId: id.optional(), target: z.enum(shellTargets) }).strict(),
  ),
} as const;

export type Methods = typeof methods;
export type MethodName = keyof Methods;
export type MethodParams<K extends MethodName> = z.input<Methods[K]['params']>;
export type MethodParamsParsed<K extends MethodName> = z.output<Methods[K]['params']>;
export type MethodResult<K extends MethodName> = NonNullable<Methods[K]['result']>;

export const subscriptionTopics = {
  events: z.object({}).strict(),
  /** build.log of a build, or its tests.log (`file: 'tests'`). */
  'build.log': z.object({ buildId: id, file: z.enum(['build', 'tests']).default('build') }).strict(),
  'container.log': z.object({ buildId: id }).strict(),
  stats: z.object({ buildId: id }).strict(),
} as const;
export type Topic = keyof typeof subscriptionTopics;

/** Wire protocol over MessagePort. */
export type ClientMessage =
  | { kind: 'req'; id: number; method: string; params: unknown }
  | { kind: 'sub'; id: number; topic: string; params: unknown }
  | { kind: 'unsub'; id: number };

export type ServerMessage =
  | { kind: 'res'; id: number; ok: true; result: unknown }
  | { kind: 'res'; id: number; ok: false; error: BmErrorShape }
  | { kind: 'event'; subId: number; data: unknown };

export interface BmErrorShape {
  code: string;
  message: string;
  details?: unknown;
}

/** Core → Main requests (things only Electron can do). */
export type CoreToMain =
  | { kind: 'ready'; pid: number }
  | { kind: 'notify'; notifType: string; title: string; body: string; route?: string; url?: string }
  | { kind: 'openExternal'; url: string }
  | { kind: 'openPath'; path: string }
  | { kind: 'busy'; activeJobs: number }
  | { kind: 'tray'; state: 'ok' | 'building' | 'error'; menu: TrayProject[] }
  | { kind: 'appConfig'; config: AppConfig }
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; msg: string };

export interface TrayProject {
  id: string;
  name: string;
  builds: { buildId: number; branchId: number; branch: string; status: string; url: string | null }[];
}

/** Main → Core. */
export type MainToCore =
  | { kind: 'init'; configDir: string; dataDirOverride: string | null; appVersion: string; resourcesPath: string }
  | { kind: 'renderer-port' }
  | { kind: 'hook'; argv: string[] }
  | { kind: 'shutdown'; cancelJobs: boolean };
