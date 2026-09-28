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
  | 'import_backup'
  | 'fetch'
  | 'apply_config';
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

export interface ProjectSummary {
  id: string;
  name: string;
  repoPath: string;
  enabled: boolean;
  configPath: string;
  configError: string | null;
  github: string | null;
  odooVersion: string;
  lastFetchAt: string | null;
  lastFetchError: string | null;
}

export type LiveIndicator = 'none' | 'building' | 'ok' | 'warning' | 'failed' | 'stopped';

export interface BranchView {
  id: number;
  projectId: string;
  name: string;
  slug: string;
  stage: Stage;
  assignedBy: 'user' | 'rule';
  tracking: 'local' | 'remote';
  worktreePath: string | null;
  protected: boolean;
  odooVersion: string;
  indicator: LiveIndicator;
  liveBuild: BuildView | null;
  activeBuild: BuildView | null;
  /** Badges: unbuilt commits, stage settings changed, config changed, dirty worktree, prod mirror newer, paused… */
  badges: BranchBadge[];
  url: string | null;
  lastActiveAt: string | null;
}

export type BranchBadgeKind =
  | 'unbuilt-commits'
  | 'stage-changed'
  | 'config-changed'
  | 'dirty-worktree'
  | 'force-push'
  | 'mirror-newer'
  | 'no-build'
  | 'discrepancy';

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
  staging: BranchView[];
  development: BranchView[];
  unassigned: UnassignedBranch[];
  hiddenCount: number;
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
  repoPath: string;
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
  postgres: { container: string; host: string; port: number; internalHost: string; user: string; hasPassword: boolean } | null;
  suggestedPreset: 'demz' | 'generic';
  warnings: string[];
  /** Project config generated from the chosen preset and the detected values (password stripped). */
  proposals: Record<'demz' | 'generic', ProjectConfig>;
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
  postgres: Record<string, ServiceStatus>;
  gh: ServiceStatus;
  disk: { freeGb: number | null; path: string; low: boolean };
  running: { count: number; limit: number };
  queue: { running: number; queued: number; maxParallel: number };
  fetches: { projectId: string; at: string | null; error: string | null }[];
  discrepancies: Discrepancy[];
  orphans: Orphan[];
  paths: { configDir: string; dataDir: string; logsDir: string };
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
