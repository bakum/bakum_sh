/**
 * Settings schemas (spec section 9). Every level of the settings hierarchy is described here,
 * including fields that only stage 2/3 act upon, so YAML written today stays valid later.
 */
import { z } from 'zod';

/** Two stages (D37): the production branch and everything else. Staging was dropped: it only differed by settings. */
export const STAGES = ['production', 'development'] as const;
export const stageSchema = z.enum(STAGES);
export type Stage = z.infer<typeof stageSchema>;

export const LEVELS = ['app', 'project', 'stage', 'rule', 'branch'] as const;
export const levelSchema = z.enum(LEVELS);
export type Level = z.infer<typeof levelSchema>;

export const LEVEL_LABELS: Record<Level, string> = {
  app: 'по умолчанию',
  project: 'из проекта',
  stage: 'из стадии',
  rule: 'из правила',
  branch: 'из ветки',
};

/** `backup` (Production only), `fresh`, `copy:production`, `copy:<branch>`. */
export const databaseSourceSchema = z
  .string()
  .regex(/^(backup|fresh|copy:[A-Za-z0-9._\/-]+)$/, 'ожидается backup | fresh | copy:production | copy:<ветка>');

const moduleListSchema = z.object({ list: z.array(z.string().regex(/^[a-z0-9_]+$/)) }).strict();

export const installSchema = z.union([z.enum(['my', 'roots', 'full']), moduleListSchema]);
export type InstallMode = z.infer<typeof installSchema>;

export const updateModulesSchema = z.union([
  z.enum(['changed', 'version-bumped', 'all']),
  moduleListSchema,
  z.object({ installedMatching: z.array(z.string().min(1)) }).strict(),
]);
export type UpdateModules = z.infer<typeof updateModulesSchema>;

export const testsSchema = z
  .object({
    mode: z.union([z.enum(['none', 'changed', 'my']), moduleListSchema]),
    tags: z.string(),
    extraArgs: z.array(z.string()),
    failBuild: z.boolean(),
  })
  .partial()
  .strict();

/**
 * Settings that can be set on any level below the project file root:
 * app defaults → project → stage → branch rule → branch (spec 9.1).
 * All fields optional: a level only states what it overrides.
 */
export const branchScopeSchema = z
  .object({
    database: databaseSourceSchema,
    cloneMethod: z.enum(['template', 'dump']),
    filestoreCopy: z.enum(['hardlink', 'copy']),
    install: installSchema,
    withDemo: z.boolean(),
    onNewCommit: z.enum(['none', 'update', 'new']),
    onForcePush: z.enum(['pause', 'new']),
    updateModules: updateModulesSchema,
    /** Deprecated (before D33 worktrees could hold a local branch); accepted in old YAML and ignored. */
    tracking: z.enum(['local', 'remote']),
    /**
     * Development only, branch level only (D33): the build mounts this folder (the user's own clone) instead of a worktree
     * of the app's mirror. The app only reads it (HEAD, status, diff) and never changes it.
     */
    folder: z.string().min(1).nullable(),
    tests: testsSchema,
    mails: z.object({ enabled: z.boolean() }).partial().strict(),
    idleStopHours: z.number().min(0),
    dropAfterDays: z.number().min(0),
    protected: z.boolean(),
    /** Build automatically when the branch is added to the project (auto-add by fetch included). */
    buildOnAdd: z.boolean(),
    image: z.string().min(1),
    env: z.record(z.string(), z.string()),
    localTweaks: z
      .object({
        baseUrl: z.boolean(),
        mailServer: z.boolean(),
        adminPassword: z.boolean(),
        extraSql: z.boolean(),
      })
      .partial()
      .strict(),
  })
  .partial()
  .strict();
export type BranchScope = z.infer<typeof branchScopeSchema>;

/** Fully resolved branch scope (after merging all levels onto the app defaults). */
export interface ResolvedBranchScope {
  database: string;
  cloneMethod: 'template' | 'dump';
  filestoreCopy: 'hardlink' | 'copy';
  install: InstallMode;
  withDemo: boolean;
  onNewCommit: 'none' | 'update' | 'new';
  onForcePush: 'pause' | 'new';
  updateModules: UpdateModules;
  /** The user's folder the code comes from (Development branch setting), null — the app's mirror of the remote. */
  folder: string | null;
  tests: { mode: 'none' | 'changed' | 'my' | { list: string[] }; tags: string; extraArgs: string[]; failBuild: boolean };
  mails: { enabled: boolean };
  idleStopHours: number;
  dropAfterDays: number;
  protected: boolean;
  buildOnAdd: boolean;
  image: string;
  env: Record<string, string>;
  localTweaks: { baseUrl: boolean; mailServer: boolean; adminPassword: boolean; extraSql: boolean };
}

export const branchMatchSchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
  z.object({ regex: z.string().min(1) }).strict(),
]);
export type BranchMatch = z.infer<typeof branchMatchSchema>;

export const branchRuleSchema = z
  .object({
    match: branchMatchSchema,
    stage: z.enum(['development', 'ignore']),
    overrides: branchScopeSchema.optional(),
  })
  .strict();
export type BranchRule = z.infer<typeof branchRuleSchema>;

export const mountSchema = z
  .object({ host: z.string().min(1), container: z.string().startsWith('/'), readOnly: z.boolean().default(false) })
  .strict();
export type Mount = z.infer<typeof mountSchema>;

const hookActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('sql'), file: z.string().optional(), sql: z.string().optional() }).strict(),
  z.object({ type: z.literal('odoo-shell'), file: z.string() }).strict(),
  z.object({ type: z.literal('container'), command: z.array(z.string()).min(1) }).strict(),
  z.object({ type: z.literal('host'), command: z.array(z.string()).min(1) }).strict(),
]);

export const hookSchema = z
  .object({
    point: z.string().regex(/^((before|after):[a-z-]+|afterImportBackup|beforeDrop)$/),
    action: hookActionSchema,
    timeoutSec: z.number().int().positive().default(300),
    onError: z.enum(['fail', 'warn']).default('fail'),
    stages: z.array(stageSchema).optional(),
    branches: z.array(z.string()).optional(),
  })
  .strict();

const idSchema = z
  .string()
  .regex(/^[a-z0-9-]+$/, 'только a-z, 0-9 и «-»')
  .min(2)
  .max(24);

export const projectConfigSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1),
    enabled: z.boolean().default(true),
    repo: z
      .object({
        /** Remote repository the code comes from (D33); may carry a user name for a token stored by Git (D31). */
        url: z.string().min(1).optional(),
        /** The app's own bare mirror of `url` (`<dataDir>/repos/<name>.git`): fetch, detached worktrees, push of new branches. */
        mirrorDir: z.string().min(1).optional(),
        /** The user's own clone (optional): suggested as the folder of Development branches, never changed by the app. */
        localFolder: z.string().min(1).nullable().default(null),
        /** Deprecated: the user's repository the app used before D33. A project with `path` and no `url` is legacy. */
        path: z.string().min(1).optional(),
        remote: z.string().default('origin'),
        github: z
          .string()
          .regex(/^[\w.-]+\/[\w.-]+$/)
          .nullable()
          .default(null),
        fetchIntervalMin: z.number().min(0).default(5),
        worktreesDir: z.string().min(1),
        protectedBranches: z.array(z.string()).default([]),
        moduleRoots: z.array(z.string()).default([]),
        modulesToInstall: z.string().nullable().default(null),
        issueUrl: z.string().nullable().default(null),
      })
      .strict(),
    naming: z
      .object({
        slug: z.string().default('{branch}'),
        slugStrip: z.string().nullable().default(null),
        db: z.string().min(1),
        host: z.string().default('{slug}.localhost'),
        composeProject: z.string().default('bm-{project}-{slug}'),
        parse: z.string().nullable().default(null),
        branch: z
          .object({
            pattern: z.string().default('{name}'),
            base: z.string().default('main'),
            types: z.record(z.string(), z.string()).optional(),
            nameRegex: z.string().default('^[a-z0-9-]+$'),
          })
          .strict()
          .prefault({}),
        pr: z
          .object({
            title: z.string().default('{branch}'),
            body: z.string().default(''),
            targets: z.array(z.string()).default([]),
          })
          .strict()
          .prefault({}),
      })
      .strict(),
    runtime: z
      .object({
        image: z.string().min(1),
        build: z.object({ context: z.string(), dockerfile: z.string().default('Dockerfile') }).nullable().default(null),
        odooVersion: z.string().default('19.0'),
        network: z.string().min(1),
        repoMount: z.string().startsWith('/'),
        mounts: z.array(mountSchema).default([]),
        filestore: z
          .object({
            hostDir: z.string().min(1),
            containerDir: z
              .string()
              .regex(/^\/.*\/filestore$/,'должен заканчиваться на /filestore (родитель — data_dir Odoo)')
              .default('/var/lib/odoo/filestore'),
            copy: z.enum(['hardlink', 'copy']).default('hardlink'),
          })
          .strict(),
        env: z.record(z.string(), z.string()).default({}),
        command: z.array(z.string()).min(1),
        debug: z
          .object({
            containerPort: z.number().int().default(5678),
            pathMappings: z.array(z.object({ local: z.string(), remote: z.string() }).strict()).default([]),
          })
          .strict()
          .prefault({}),
        healthcheck: z
          .object({ path: z.string().default('/web/login'), timeoutSec: z.number().int().positive().default(180) })
          .strict()
          .prefault({}),
        composeTemplate: z.string().nullable().default(null),
        /** Container path of Odoo Enterprise addons (mounted read-only, listed in the addons path); fresh databases get web_enterprise. */
        enterprise: z.string().startsWith('/').nullable().default(null),
      })
      .strict(),
    postgres: z
      .object({
        /** external — an existing Postgres; managed — the app runs its own container bm-<project>-db (D30). */
        mode: z.enum(['external', 'managed']).default('external'),
        image: z.string().min(1).default('postgres:16'),
        host: z.string().default('localhost'),
        port: z.number().int().default(5432),
        internalHost: z.string().default('db'),
        user: z.string().default('odoo'),
        password: z.string().default(''),
        protectedDbs: z.array(z.string()).default(['postgres']),
        protectedContainers: z.array(z.string()).default([]),
      })
      .strict(),
    production: z
      .object({
        branch: z.string().min(1),
        slug: z.string().regex(/^[a-z0-9-]+$/).default('prod'),
        backups: z
          .object({
            dir: z.string().nullable().default(null),
            pattern: z.string().default('*.zip'),
            pick: z.enum(['latest', 'manual']).default('latest'),
            autoImport: z.boolean().default(false),
          })
          .strict()
          .prefault({}),
        postRestore: z
          .object({ sql: z.array(z.string()).default([]), verifySql: z.string().nullable().default(null) })
          .strict()
          .prefault({}),
        updateModules: updateModulesSchema.default('all'),
      })
      .strict(),
    stages: z
      .object({
        production: branchScopeSchema.optional(),
        development: branchScopeSchema.optional(),
      })
      .strict()
      .prefault({}),
    branchRules: z.array(branchRuleSchema).default([]),
    autoAddBranches: z.enum(['none', 'rules', 'all']).default('none'),
    connect: z.object({ adminPassword: z.string().nullable().default(null) }).strict().prefault({}),
    extraSql: z.array(z.string()).default([]),
    hooks: z.array(hookSchema).default([]),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (!cfg.repo.path && !(cfg.repo.url && cfg.repo.mirrorDir)) {
      ctx.addIssue({ code: 'custom', path: ['repo', 'url'], message: 'нужны repo.url и repo.mirrorDir (адрес репозитория и копия приложения)' });
    }
    // The folder is a per-branch choice: one clone has one checked-out branch.
    for (const s of STAGES) {
      if (cfg.stages[s]?.folder != null) ctx.addIssue({ code: 'custom', path: ['stages', s, 'folder'], message: 'folder задаётся только в настройках ветки' });
    }
    cfg.branchRules.forEach((r, i) => {
      if (r.overrides?.folder != null) ctx.addIssue({ code: 'custom', path: ['branchRules', i, 'overrides', 'folder'], message: 'folder задаётся только в настройках ветки' });
    });
  });
export type ProjectConfig = z.infer<typeof projectConfigSchema>;

/** Project created before D33: the app worked inside the user's repository (`repo.path`). It can only be deleted. */
export const isLegacyProject = (cfg: ProjectConfig): boolean => !cfg.repo.url || !cfg.repo.mirrorDir;
export type ProjectConfigInput = z.input<typeof projectConfigSchema>;

export const notificationKinds = ['buildReady', 'buildFailed', 'testsFailed', 'newBackup', 'lowDisk'] as const;
export type NotificationKind = (typeof notificationKinds)[number];

export const appConfigSchema = z
  .object({
    dataDir: z.string().default('%LOCALAPPDATA%/Odoo Branch Manager'),
    proxyPort: z.number().int().min(1).max(65535).default(80),
    debugPortRange: z.tuple([z.number().int(), z.number().int()]).default([5700, 5799]),
    limits: z
      .object({
        maxParallelBuilds: z.number().int().min(1).default(2),
        maxRunningBuilds: z.number().int().min(1).default(4),
        enforce: z.boolean().default(false),
        minFreeDiskGb: z.number().min(0).default(20),
      })
      .strict()
      .prefault({}),
    traefik: z
      .object({ image: z.string().default('traefik:v3.5') })
      .strict()
      .prefault({}),
    /** Update check against GitHub Releases (docs/decisions.md D29). */
    updates: z
      .object({
        checkOnStart: z.boolean().default(true),
        repository: z
          .string()
          .regex(/^[\w.-]+\/[\w.-]+$/, 'ожидается owner/repo')
          .default('bakum/bakum_sh'),
        includePrerelease: z.boolean().default(false),
      })
      .strict()
      .prefault({}),
    desktop: z
      .object({
        autostart: z.boolean().default(false),
        startMinimized: z.boolean().default(true),
        closeToTray: z.boolean().default(true),
        theme: z.enum(['system', 'light', 'dark']).default('system'),
        notifications: z
          .object({
            buildReady: z.boolean().default(true),
            buildFailed: z.boolean().default(true),
            testsFailed: z.boolean().default(true),
            newBackup: z.boolean().default(true),
            lowDisk: z.boolean().default(true),
          })
          .strict()
          .prefault({}),
        browser: z
          .union([z.literal('default'), z.object({ exe: z.string(), args: z.array(z.string()).default([]) })])
          .default('default'),
        editor: z.string().default('code'),
        terminal: z.enum(['wt', 'git-bash', 'cmd']).default('wt'),
        dockerDesktopExe: z.string().default('auto'),
        gh: z.string().default('auto'),
      })
      .strict()
      .prefault({}),
  })
  .strict();
export type AppConfig = z.infer<typeof appConfigSchema>;
