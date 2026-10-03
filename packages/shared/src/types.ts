/** Plain view types returned by Core. Params are validated by zod (ipc.ts); results are typed only. */
import type { Level, Stage, ProjectConfig, AppConfig, ResolvedBranchScope, BranchScope } from './config';

export type BuildStatus = 'queued' | 'building' | 'running' | 'stopped' | 'failed' | 'dropped';
export type BuildTrigger = 'new_commit' | 'rebuild' | 'manual' | 'import_backup' | 'stage_change';
export type BuildKind = 'new' | 'update';
export type JobType =
  | 'build'
  | 'start'
  | 'stop'
  | 'restart'
  | 'drop'
  | 'delete_branch'
  | 'snapshot'
  | 'restore_snapshot'
  | 'delete_snapshot'
  | 'export_db'
  | 'build_image'
  | 'import_backup'
  | 'fetch'
  | 'apply_config'
  | 'modules'
  | 'tests'
  | 'delete_project'
  | 'clone'
  | 'setup_project'
  | 'migrate_postgres';
export type JobStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'interrupted';

export const BUILD_STEPS = [
  'code',
  'port',
  'database',
  'filestore',
  'local-tweaks',
  'modules',
  'tests',
  'up',
  'finalize',
] as const;
export type BuildStepName = (typeof BUILD_STEPS)[number];
export type StepStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export interface BuildStep {
  name: BuildStepName;
  status: StepStatus;
  startedAt: string | null;
  finishedAt: string | null;
  note?: string;
}

export interface CommitInfo {
  sha: string;
  author: string;
  /** Author email: the avatar in History (D65). Absent in builds recorded before 0.13.18 until backfilled. */
  email?: string;
  date: string;
  message: string;
}

export interface TestsResult {
  passed: number;
  failed: number;
  errors: number;
  warnings: number;
  failures: string[];
}

export interface OdooEdition {
  kind: 'enterprise' | 'community';
  /** Host folder with the Enterprise addons, if found. */
  source: string | null;
  /** How the edition was determined (shown as a hint). */
  note: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  /** Where the code comes from: the remote URL (for a legacy project — the user's repository). */
  repoPath: string;
  /** Created before D33 (the app worked inside the user's repository): can only be deleted and added anew. */
  legacy: boolean;
  /** Community or Enterprise, from the project settings; null when the settings file has an error. */
  edition: OdooEdition | null;
  enabled: boolean;
  configPath: string;
  configError: string | null;
  github: string | null;
  odooVersion: string;
  lastFetchAt: string | null;
  lastFetchError: string | null;
}

/** `unknown` — there is a live build, but Docker is down, so whether it runs is not known (D63). */
export type LiveIndicator = 'none' | 'building' | 'ok' | 'warning' | 'failed' | 'stopped' | 'unknown';

export interface BranchView {
  id: number;
  projectId: string;
  name: string;
  slug: string;
  stage: Stage;
  assignedBy: 'user' | 'rule';
  /** The user's folder the code comes from (Development setting, D33); null — the app's mirror of the remote. */
  folder: string | null;
  /** Branch open in `folder` ('(detached)' for a detached HEAD); null — no folder or not read yet. */
  folderBranch: string | null;
  /**
   * Another branch is open in `folder` (D59): the build is blocked — only Stop works (no Drop, no Delete of the branch),
   * commits in the folder do not trigger builds. Lifts itself once this branch is open there again.
   */
  folderBlocked: boolean;
  worktreePath: string | null;
  /** Folder the build mounts: `folder` or the worktree. */
  codeDir: string | null;
  protected: boolean;
  odooVersion: string;
  indicator: LiveIndicator;
  liveBuild: BuildView | null;
  activeBuild: BuildView | null;
  /** Badges: unbuilt commits, stage settings changed, config changed, dirty worktree, prod mirror newer, paused… */
  badges: BranchBadge[];
  /** Behind the code of the copied database's source (null — not a copy, not behind, or not computed yet). */
  codeLag: CodeLag | null;
  url: string | null;
  lastActiveAt: string | null;
  /** Hidden from the sidebar by the user (context menu «Скрыть»); builds keep working. */
  hidden: boolean;
}

export type BranchBadgeKind =
  | 'unbuilt-commits'
  | 'stage-changed'
  | 'config-changed'
  | 'dirty-worktree'
  | 'force-push'
  | 'mirror-newer'
  /** The branch lacks commits of the source build its database is copied from (D47). */
  | 'behind-source'
  /** …and has no commits of its own: it is fully merged into the source. */
  | 'merged-behind'
  | 'no-build'
  | 'discrepancy'
  /** Another branch is open in the user's folder: the build is blocked (D59). */
  | 'folder-wrong-branch'
  /** The worktree the container runs is not on the live build's commit (D64). */
  | 'worktree-off-build';

/** Code lag of a branch behind the build its database is copied from (D47). */
export interface CodeLag {
  /** Source branch (the production branch for copy:production). */
  source: string;
  production: boolean;
  /** Commit of the source build (what the source database was upgraded with). */
  sourceSha: string;
  /** Commits of the source missing in the branch. */
  behind: number;
  /** Commits of the branch missing in the source. */
  ahead: number;
  /** Modules changed by the missing commits: older in the branch than in the source database. */
  modules: string[];
}

export interface BranchBadge {
  kind: BranchBadgeKind;
  text: string;
}

export interface UnassignedBranch {
  name: string;
  source: 'remote' | 'local' | 'both';
  suggestedStage: Stage | 'ignore';
  ruleIndex: number | null;
}

export interface BranchesList {
  projectId: string;
  production: BranchView[];
  development: BranchView[];
  unassigned: UnassignedBranch[];
  /** Branches not added because a rule says `stage: ignore`. */
  ignoredCount: number;
  /** `autoAddBranches` of the project: with `all` / `rules` new remote branches are added by fetch, not under «+». */
  autoAdd: 'none' | 'rules' | 'all';
}

export interface BuildView {
  id: number;
  branchId: number;
  branchName: string;
  projectId: string;
  stage: Stage;
  number: number;
  commitSha: string | null;
  commits: CommitInfo[];
  trigger: BuildTrigger;
  kind: BuildKind;
  dbSource: string;
  dbName: string;
  debugPort: number | null;
  status: BuildStatus;
  tests: TestsResult | null;
  steps: BuildStep[];
  logPath: string | null;
  configHash: string | null;
  configChanged: boolean;
  createdAt: string;
  finishedAt: string | null;
  droppedAt: string | null;
  errorMessage: string | null;
  url: string | null;
  containerState: string | null;
  isLive: boolean;
  /** Date after which the build is auto-dropped (dropAfterDays), if any. */
  dropAt: string | null;
}

/** Monitor tab of a build (spec 8.9): the last hour of resources and requests, sizes, lifecycle dates. */
/** Periods of the Monitor charts (D74): samples and requests are kept for 7 days. */
export const MONITOR_PERIODS = ['1h', '6h', '24h', '7d'] as const;
export type MonitorPeriod = (typeof MONITOR_PERIODS)[number];

export interface MonitorView {
  buildId: number;
  running: boolean;
  period: MonitorPeriod;
  /** Bounds of the charts (ISO) and the width of one point / column, seconds (30 s samples, 60 s requests for 1 h). */
  from: string;
  to: string;
  bucketSec: number;
  /** CPU % (of one core = 100) and RAM of the branch's builds over the period, averaged per bucket. */
  resources: { at: string; cpu: number; memMb: number }[];
  /** The last sample of this build if it is fresh (the «now» tiles); null when the container is not sampled. */
  current: { at: string; cpu: number; memMb: number } | null;
  memLimitMb: number | null;
  /** Requests through Traefik per bucket (background websocket / longpolling excluded); `minute` — bucket start. */
  requests: { minute: string; count: number; avgMs: number; maxMs: number; errors: number }[];
  dbSizeBytes: number | null;
  filestoreBytes: number | null;
  lastActiveAt: string | null;
  /** When the build stops for inactivity (idleStopHours); null — never. */
  idleStopAt: string | null;
  /** After this date the build may be dropped (dropAfterDays); null — never. */
  expiresAt: string | null;
  idleStopHours: number;
  dropAfterDays: number;
}

/** Snapshot of a live build's database + filestore (spec 8.9 Backups): `<db>_snap_<n>`. */
export interface SnapshotView {
  id: number;
  /** Label given by the user or the app («перед откатом к …»). */
  name: string;
  dbName: string;
  sizeBytes: number | null;
  createdAt: string;
}

/** A record of Audit Logs (spec 8.11); `diff` — line diff of a settings change (`+ ` / `- ` lines). */
export interface AuditEntryView {
  id: number;
  at: string;
  projectId: string | null;
  action: string;
  target: string;
  params: Record<string, unknown>;
  result: string;
  diff: string | null;
}

export interface AuditList {
  items: AuditEntryView[];
  total: number;
  /** Distinct actions of the filtered scope (project / app), for the action filter. */
  actions: string[];
}

export interface JobView {
  id: number;
  type: JobType;
  status: JobStatus;
  projectId: string | null;
  branchId: number | null;
  buildId: number | null;
  params: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface DetectResult {
  /** The app's bare mirror the project will work in (D33). */
  mirrorDir: string;
  url: string;
  /** The user's own clone given in the wizard (only read), null when the project was started from a URL. */
  localFolder: string | null;
  isGitRepo: boolean;
  remote: string | null;
  remoteUrl: string | null;
  github: string | null;
  currentBranch: string | null;
  branches: string[];
  productionCandidate: string | null;
  moduleRoots: string[];
  moduleCount: number;
  modulesToInstall: string | null;
  projectRoot: string | null;
  composeFile: string | null;
  dockerfile: string | null;
  odooConf: string | null;
  image: string | null;
  network: string | null;
  repoMount: string | null;
  mounts: { host: string; container: string; readOnly: boolean }[];
  command: string[] | null;
  postgres: { container: string; image: string; host: string; port: number; internalHost: string; user: string; hasPassword: boolean } | null;
  /** Odoo series of the repository (manifest versions, production branch), e.g. «19.0». */
  odooVersion: string;
  suggestedPreset: PresetId;
  warnings: string[];
  /** Project config generated from the chosen preset and the detected values (password stripped). */
  proposals: Record<PresetId, ProjectConfig>;
}

/** demz — the DEMZ project; generic — an existing Odoo in Docker; odoo — the app runs Odoo and Postgres itself. */
export type PresetId = 'demz' | 'generic' | 'odoo';

export const ODOO_VERSIONS = ['19.0', '18.0', '17.0', '16.0'] as const;

/** Access check of a remote repository (`git ls-remote`), docs/decisions.md D31. */
export interface RepoProbe {
  ok: boolean;
  url: string;
  /** auth — no credentials; denied — credentials without access or no such repository; ssh-key / host-key — SSH setup. */
  problem: 'auth' | 'denied' | 'ssh-key' | 'host-key' | 'network' | 'no-helper' | 'other' | null;
  message: string | null;
  branches: string[];
  defaultBranch: string | null;
  /** The URL uses https (a token can be saved for it). */
  https: boolean;
  /** Git credential helper configured (credential.helper), e.g. «manager». */
  helper: string | null;
}

export interface EffectiveField {
  path: string;
  value: unknown;
  level: Level;
}

export interface EffectiveConfig {
  branchId: number;
  stage: Stage;
  ruleIndex: number | null;
  scope: ResolvedBranchScope;
  fields: EffectiveField[];
  branchOverrides: BranchScope;
}

export interface ServiceStatus {
  ok: boolean;
  text: string;
}

export interface SystemStatus {
  docker: ServiceStatus & { version: string | null };
  traefik: ServiceStatus & { port: number | null };
  git: ServiceStatus;
  postgres: Record<string, ServiceStatus>;
  gh: ServiceStatus;
  disk: { freeGb: number | null; path: string; low: boolean };
  running: { count: number; limit: number };
  queue: { running: number; queued: number; maxParallel: number };
  fetches: { projectId: string; at: string | null; error: string | null }[];
  discrepancies: Discrepancy[];
  orphans: Orphan[];
  /**
   * Assistant skills behind what the app writes now (D52, D75): written by an older version or before a settings
   * change. `modified` — also edited by hand, so it is rewritten only after a confirmation in the project settings.
   */
  outdatedSkills: OutdatedSkill[];
  paths: { configDir: string; dataDir: string; logsDir: string };
}

export interface OutdatedSkill {
  projectId: string;
  projectName: string;
  path: string;
  /** Folder the skill was installed into (`agents.skillsDir`): «Обновить» writes there again. */
  dir: string;
  installedVersion: string | null;
  currentVersion: string;
  modified: boolean;
}

export interface Discrepancy {
  projectId: string;
  kind: 'container-missing' | 'container-unexpected' | 'db-missing' | 'worktree-missing' | 'job-interrupted';
  target: string;
  text: string;
}

export interface Orphan {
  projectId: string | null;
  kind: 'database' | 'filestore' | 'compose' | 'container' | 'worktree';
  name: string;
}

export interface AppStateView {
  firstRun: boolean;
  app: AppConfig;
  configDir: string;
  dataDir: string;
  proxyPort: number;
  version: string;
}

export interface CoreEvent {
  type:
    | 'project.changed'
    | 'branch.changed'
    | 'build.changed'
    | 'job.changed'
    | 'system.changed'
    | 'config.changed'
    | 'notification';
  projectId?: string;
  branchId?: number;
  buildId?: number;
  jobId?: number;
  message?: string;
}

export interface LogChunk {
  lines: string[];
  reset?: boolean;
}

export interface BackupFile {
  name: string;
  path: string;
  sizeBytes: number;
  mtime: string;
}

export interface ChangedModules {
  from: string | null;
  to: string | null;
  files: number;
  modules: { name: string; path: string; action: 'update' | 'install' | 'none' | 'removed' }[];
}

export interface GitBranchInfo {
  name: string;
  source: 'remote' | 'local' | 'both';
}

/** Application update state (main process updater, docs/decisions.md D29). */
export interface UpdateState {
  status: 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';
  current: string;
  latest: string | null;
  notes: string | null;
  url: string | null;
  publishedAt: string | null;
  asset: { name: string; size: number } | null;
  progress: number | null;
  error: string | null;
  checkedAt: string | null;
  /** installer — download and run Setup; portable — open the release page; dev — not available. */
  mode: 'installer' | 'portable' | 'dev';
  skipped: boolean;
}
