/**
 * IPC contract between renderer / main and Core (spec section 10).
 * Params are zod schemas and are validated inside Core; results are typed via phantom generics.
 */
import { z } from 'zod';
import { branchScopeSchema, levelSchema, stageSchema, type ProjectConfig, type AppConfig } from './config';
import type {
  AppStateView,
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
  'projects.detect': m<DetectResult>()(z.object({ path: z.string().min(1) }).strict()),
  'projects.create': m<ProjectSummary>()(z.object({ yaml: z.string().min(1) }).strict()),
  'projects.update': m<ProjectSummary>()(z.object({ projectId, yaml: z.string().min(1) }).strict()),
  'projects.setEnabled': m<ProjectSummary>()(z.object({ projectId, enabled: z.boolean() }).strict()),
  'projects.deletePreview': m<{ builds: string[]; databases: string[]; filestores: string[]; worktrees: string[] }>()(
    z.object({ projectId }).strict(),
  ),
  'projects.delete': m<JobRef>()(z.object({ projectId, confirm: z.string() }).strict()),

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
  'branches.setOverrides': m<BranchView>()(z.object({ branchId: id, overrides: branchScopeSchema }).strict()),
  'branches.fork': m<{ branch: BranchView; jobId: number | null }>()(
    z.object({ branchId: id, name: z.string().min(1), push: z.boolean().default(false) }).strict(),
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
        deleteLocal: z.boolean().default(false),
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

  'git.fetch': m<{ jobs: number[] }>()(z.object({ projectId: projectId.optional() }).strict()),

  'jobs.list': m<JobView[]>()(
    z.object({ projectId: projectId.optional(), active: z.boolean().optional(), limit: z.number().int().optional() }).strict(),
  ),
  'jobs.get': m<JobView>()(z.object({ jobId: id }).strict()),
  'jobs.cancel': m<{ ok: true }>()(z.object({ jobId: id }).strict()),

  'audit.list': m<{ id: number; at: string; projectId: string | null; action: string; target: string; result: string }[]>()(
    z.object({ projectId: projectId.optional(), limit: z.number().int().optional() }).strict(),
  ),

  'logs.read': m<{ lines: string[]; path: string | null }>()(
    z.object({ buildId: id, kind: z.enum(['build', 'odoo']), tail: z.number().int().optional() }).strict(),
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
  'build.log': z.object({ buildId: id }).strict(),
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
