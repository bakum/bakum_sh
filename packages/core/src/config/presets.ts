import type { BranchScope, ProjectConfigInput, ResolvedBranchScope, Stage } from '@bm/shared';

/**
 * App-level defaults per stage ("приложение" in spec 9.1) — the odoo.sh behaviour.
 * Everything a project, stage, rule or branch does not state falls back to these.
 */
export const APP_STAGE_DEFAULTS: Record<Stage, ResolvedBranchScope> = {
  production: {
    database: 'backup',
    cloneMethod: 'template',
    filestoreCopy: 'hardlink',
    install: 'my',
    withDemo: false,
    onNewCommit: 'update',
    onForcePush: 'pause',
    updateModules: 'changed',
    folder: null,
    tests: { mode: 'none', tags: '/{module}', extraArgs: [], failBuild: false },
    mails: { enabled: false },
    idleStopHours: 0,
    dropAfterDays: 0,
    protected: true,
    buildOnAdd: false,
    deleteWithRemote: false,
    image: '',
    env: {},
    localTweaks: { baseUrl: true, mailServer: true, adminPassword: true, extraSql: true },
  },
  development: {
    database: 'fresh',
    cloneMethod: 'template',
    filestoreCopy: 'hardlink',
    install: 'my',
    withDemo: true,
    onNewCommit: 'new',
    onForcePush: 'pause',
    updateModules: 'changed',
    folder: null,
    tests: { mode: 'changed', tags: '/{module}', extraArgs: [], failBuild: false },
    mails: { enabled: true },
    idleStopHours: 8,
    dropAfterDays: 14,
    protected: false,
    buildOnAdd: false,
    deleteWithRemote: true,
    image: '',
    env: {},
    localTweaks: { baseUrl: true, mailServer: true, adminPassword: true, extraSql: true },
  },
};

export interface RepoInputs {
  url: string;
  mirrorDir: string;
  localFolder: string | null;
}

export interface PresetInputs {
  id: string;
  name: string;
  /** Code source (D33): the remote URL, the app's mirror of it, the user's own clone (optional, never changed). */
  repo: RepoInputs;
  github: string | null;
  remote: string;
  projectRoot: string | null;
  worktreesDir: string;
  moduleRoots: string[];
  modulesToInstall: string | null;
  image: string;
  network: string;
  repoMount: string;
  mounts: { host: string; container: string; readOnly: boolean }[];
  filestoreHostDir: string;
  postgres: { host: string; port: number; internalHost: string; user: string; password: string; protectedContainers: string[] };
  /**
   * The app's own Postgres (D30), the default for new projects: bm-<id>-db in the network bm-<id>, with the detected
   * user and internal host (the stack's odoo.conf keeps working). Without it the detected Postgres is used (external).
   */
  managedPg?: { image: string; port: number };
  /** addons_path entries of the detected stack outside the repository (`stackAddons`), before `{addonsPath}`. */
  stackAddons: string[];
  /** The detected Odoo container runs debugpy (Generic preset keeps it; otherwise plain `odoo`). */
  debugpy?: boolean;
  productionBranch: string;
  odooVersion: string;
}

export const ODOO_CORE_ADDONS = '/usr/lib/python3/dist-packages/odoo/addons';

/**
 * addons_path of the detected stack (its odoo.conf) without the repository: entries equal to, inside or above
 * `repoMount` are replaced by the build's `{addonsPath}` (D48); core addons when the stack states nothing.
 */
export function stackAddons(addonsPath: string | null, repoMount: string): string[] {
  const repo = repoMount.replace(/\/+$/, '');
  const related = (p: string): boolean => p === repo || p.startsWith(`${repo}/`) || repo.startsWith(`${p}/`);
  const kept = (addonsPath ?? '')
    .split(',')
    .map((p) => p.trim().replace(/\/+$/, ''))
    .filter((p) => p.startsWith('/') && !related(p));
  return kept.length ? [...new Set(kept)] : [ODOO_CORE_ADDONS];
}

/** postgres section of the DEMZ / Generic presets: the app's own container or the detected one. */
function pgSection(i: PresetInputs, protectedDbs: string[]) {
  const common = { internalHost: i.postgres.internalHost, user: i.postgres.user, password: i.postgres.password, protectedDbs };
  if (!i.managedPg) {
    return { mode: 'external' as const, host: i.postgres.host, port: i.postgres.port, ...common, protectedContainers: i.postgres.protectedContainers };
  }
  return {
    mode: 'managed' as const,
    image: i.managedPg.image,
    host: 'localhost',
    port: i.managedPg.port,
    ...common,
    protectedContainers: [...new Set([...i.postgres.protectedContainers, `bm-${i.id}-db`])],
  };
}

/** The app's own Postgres lives in its own network; the detected one — in the network of the user's stack. */
const networkOf = (i: PresetInputs): string => (i.managedPg ? `bm-${i.id}` : i.network);

const DEMZ_VERIFY_SQL =
  "SELECT count(*) FROM ir_config_parameter WHERE key IN ('database.enterprise_code', 'database.expiration_date', " +
  "'database.expiration_reason', 'database.already_linked_subscription_url', 'database.already_linked_email', " +
  "'database.already_linked_send_mail_url')";

/**
 * DEMZ preset (spec 9.3) with the corrections from docs/decisions.md:
 * filestore gets its own mount at /var/lib/odoo/filestore and `--data-dir=/var/lib/odoo` (D7),
 * shared host folders are mounted read-only (D8).
 */
export function demzPreset(i: PresetInputs): ProjectConfigInput {
  const root = i.projectRoot ?? 'E:/demz-odoo-19';
  return {
    id: i.id,
    name: i.name,
    repo: {
      url: i.repo.url,
      mirrorDir: i.repo.mirrorDir,
      localFolder: i.repo.localFolder,
      remote: i.remote,
      github: i.github,
      fetchIntervalMin: 5,
      worktreesDir: i.worktreesDir,
      protectedBranches: ['19.0', '19.0-demz-prerelease', '19.0-demz-crm'],
      moduleRoots: i.moduleRoots.length ? i.moduleRoots : ['demzua', 'todoltd', 'exchange', 'oca', 'printer'],
      modulesToInstall: i.modulesToInstall ?? 'demzua/modules_to_install.txt',
      issueUrl: i.github ? `https://github.com/${i.github}/issues/{issue}` : null,
    },
    naming: {
      slug: '{branch}',
      slugStrip: '^19\\.0-demz-',
      db: 'o19_br_{slug_}_{build}',
      host: '{slug}.localhost',
      composeProject: 'bm-{project}-{slug}',
      parse: null,
      branch: { pattern: '19.0-demz-{name}', base: '19.0', nameRegex: '^[a-z0-9-]+$' },
      pr: { title: '{branch}', body: '', targets: ['19.0-demz-crm', '19.0'] },
    },
    runtime: {
      image: i.image,
      odooVersion: i.odooVersion,
      network: networkOf(i),
      repoMount: i.repoMount,
      mounts: i.mounts,
      filestore: { hostDir: i.filestoreHostDir, containerDir: '/var/lib/odoo/filestore', copy: 'hardlink' },
      env: {},
      command: [
        'python3', '-Xfrozen_modules=off', '-m', 'debugpy', '--listen', '0.0.0.0:5678',
        '/usr/bin/odoo', '-c', '/etc/odoo/odoo.conf', '--data-dir=/var/lib/odoo',
        // Overrides addons_path of the shared odoo.conf: module folders come from the build's own code (D48).
        `--addons-path=${[...i.stackAddons, '{addonsPath}'].join(',')}`,
        // debugpy bypasses the image entrypoint, so the connection comes from the postgres settings, not the shared
        // odoo.conf; the empty --db_password clears the conf's one and libpq takes PGPASSWORD of the container (D54).
        `--db_host=${i.postgres.internalHost}`, '--db_port=5432', `--db_user=${i.postgres.user}`, '--db_password=',
        '-d', '{db}', '--db-filter=^{db}$', '--proxy-mode',
      ],
      debug: {
        containerPort: 5678,
        pathMappings: [
          { local: '{worktree}', remote: i.repoMount },
          { local: `${root}/enterprise`, remote: '/mnt/enterprise' },
        ],
      },
      healthcheck: { path: '/web/login', timeoutSec: 180 },
      composeTemplate: null,
    },
    postgres: pgSection(i, ['postgres', 'o19_test']),
    production: {
      branch: i.productionBranch,
      slug: 'prod',
      backups: { dir: `${root}/data/backups`, pattern: 'db-backup-o19-demz-prod-*.zip', pick: 'latest', autoImport: false },
      postRestore: { sql: [`${root}/scripts/sql/detach_production_license.sql`], verifySql: DEMZ_VERIFY_SQL },
      updateModules: { installedMatching: ['td_*', 'ata_*', 'demz_*'] },
    },
    stages: {
      production: {
        onNewCommit: 'update',
        tests: { mode: 'none' },
        mails: { enabled: false },
        idleStopHours: 0,
        dropAfterDays: 0,
      },
      development: {
        database: 'copy:production',
        install: 'my',
        withDemo: false,
        onNewCommit: 'update',
        updateModules: 'changed',
        tests: { mode: 'changed' },
        mails: { enabled: true },
        idleStopHours: 8,
        dropAfterDays: 14,
      },
    },
    branchRules: [
      { match: 'backup/*', stage: 'ignore' },
      { match: '*', stage: 'development' },
    ],
    autoAddBranches: 'all',
    connect: { adminPassword: 'admin' },
    extraSql: [],
    hooks: [],
  };
}

export interface OdooPresetInputs {
  id: string;
  name: string;
  repo: RepoInputs;
  repoName: string;
  github: string | null;
  remote: string;
  worktreesDir: string;
  filestoreHostDir: string;
  moduleRoots: string[];
  modulesToInstall: string | null;
  productionBranch: string;
  odooVersion: string;
  /** Host port of the project's own Postgres (127.0.0.1 only). */
  pgPort: number;
  /** Host folder of Odoo Enterprise addons, null for Community. */
  enterpriseDir: string | null;
}

/**
 * «Odoo in Docker» preset (docs/decisions.md D32): nothing but a git repository is needed. The app runs the official
 * `odoo:<series>` image and its own Postgres container (`postgres.mode: managed`, D30) in the network `bm-<project>`.
 * Production starts from a fresh database (a backups folder turns it into a mirror of production later),
 * Development gets a fresh database with demo data — the odoo.sh behaviour.
 */
export function odooPreset(i: OdooPresetInputs): ProjectConfigInput {
  const prefix = i.id.replace(/-/g, '_');
  const repoMount = `/mnt/repo/${i.repoName}`;
  const enterpriseMount = '/mnt/enterprise';
  const addons = [
    ...(i.enterpriseDir ? [enterpriseMount] : []),
    ODOO_CORE_ADDONS,
    '{addonsPath}',
  ];
  const install = i.modulesToInstall ? ('my' as const) : ('roots' as const);
  return {
    id: i.id,
    name: i.name,
    repo: {
      url: i.repo.url,
      mirrorDir: i.repo.mirrorDir,
      localFolder: i.repo.localFolder,
      remote: i.remote,
      github: i.github,
      fetchIntervalMin: 5,
      worktreesDir: i.worktreesDir,
      protectedBranches: [i.productionBranch],
      moduleRoots: i.moduleRoots,
      modulesToInstall: i.modulesToInstall,
      issueUrl: i.github ? `https://github.com/${i.github}/issues/{issue}` : null,
    },
    naming: {
      slug: '{branch}',
      slugStrip: null,
      db: `bm_${prefix}_{slug_}_{build}`,
      host: `{slug}.${i.id}.localhost`,
      composeProject: 'bm-{project}-{slug}',
      parse: null,
      branch: { pattern: '{name}', base: i.productionBranch, nameRegex: '^[a-z0-9-/]+$' },
      pr: { title: '{branch}', body: '', targets: [i.productionBranch] },
    },
    runtime: {
      image: `odoo:${i.odooVersion}`,
      odooVersion: i.odooVersion,
      network: `bm-${i.id}`,
      repoMount,
      mounts: i.enterpriseDir ? [{ host: i.enterpriseDir, container: enterpriseMount, readOnly: true }] : [],
      filestore: { hostDir: i.filestoreHostDir, containerDir: '/var/lib/odoo/filestore', copy: 'hardlink' },
      env: {},
      // The official image has no debugpy (D26); the entrypoint adds --db_password from PASSWORD (set from postgres).
      command: [
        'odoo',
        '--data-dir=/var/lib/odoo',
        `--addons-path=${addons.join(',')}`,
        '--db_host=db', '--db_port=5432', '--db_user=odoo',
        '-d', '{db}', '--db-filter=^{db}$', '--proxy-mode',
      ],
      debug: {
        containerPort: 5678,
        pathMappings: [
          { local: '{worktree}', remote: repoMount },
          ...(i.enterpriseDir ? [{ local: i.enterpriseDir, remote: enterpriseMount }] : []),
        ],
      },
      healthcheck: { path: '/web/login', timeoutSec: 300 },
      composeTemplate: null,
      enterprise: i.enterpriseDir ? enterpriseMount : null,
    },
    postgres: {
      mode: 'managed',
      image: 'postgres:16',
      host: 'localhost',
      port: i.pgPort,
      internalHost: 'db',
      user: 'odoo',
      password: '',
      protectedDbs: ['postgres'],
      protectedContainers: [`bm-${i.id}-db`],
    },
    production: {
      branch: i.productionBranch,
      slug: 'prod',
      backups: { dir: null, pattern: '*.zip', pick: 'latest', autoImport: false },
      postRestore: { sql: [], verifySql: null },
      updateModules: 'all',
    },
    stages: {
      production: { install, withDemo: false, onNewCommit: 'update', updateModules: 'changed' } satisfies BranchScope,
      development: { database: 'fresh', install, withDemo: true, onNewCommit: 'new' } satisfies BranchScope,
    },
    branchRules: [],
    autoAddBranches: 'all',
    connect: { adminPassword: null },
    extraSql: [],
    hooks: [],
  };
}

/** Generic Odoo preset (spec 9.4): odoo.sh defaults, fresh Development databases. */
export function genericPreset(i: PresetInputs): ProjectConfigInput {
  const prefix = i.id.replace(/-/g, '_');
  return {
    id: i.id,
    name: i.name,
    repo: {
      url: i.repo.url,
      mirrorDir: i.repo.mirrorDir,
      localFolder: i.repo.localFolder,
      remote: i.remote,
      github: i.github,
      fetchIntervalMin: 5,
      worktreesDir: i.worktreesDir,
      protectedBranches: [i.productionBranch],
      moduleRoots: i.moduleRoots,
      modulesToInstall: i.modulesToInstall,
      issueUrl: null,
    },
    naming: {
      slug: '{branch}',
      slugStrip: null,
      db: `bm_${prefix}_{slug_}_{build}`,
      host: `{slug}.${i.id}.localhost`,
      composeProject: 'bm-{project}-{slug}',
      parse: null,
      branch: { pattern: '{name}', base: i.productionBranch, nameRegex: '^[a-z0-9-/]+$' },
      pr: { title: '{branch}', body: '', targets: [i.productionBranch] },
    },
    runtime: {
      image: i.image,
      odooVersion: i.odooVersion,
      network: networkOf(i),
      repoMount: i.repoMount,
      mounts: i.mounts,
      filestore: { hostDir: i.filestoreHostDir, containerDir: '/var/lib/odoo/filestore', copy: 'hardlink' },
      env: i.postgres.password ? { PGPASSWORD: i.postgres.password } : {},
      command: [
        // debugpy only when the detected Odoo container already runs it (the official odoo image has no debugpy).
        ...(i.debugpy ? ['python3', '-Xfrozen_modules=off', '-m', 'debugpy', '--listen', '0.0.0.0:5678', '/usr/bin/odoo'] : ['odoo']),
        '--data-dir=/var/lib/odoo',
        `--addons-path=${[...i.stackAddons, '{addonsPath}'].join(',')}`,
        `--db_host=${i.postgres.internalHost}`, '--db_port=5432', `--db_user=${i.postgres.user}`,
        '-d', '{db}', '--db-filter=^{db}$', '--proxy-mode',
      ],
      debug: { containerPort: 5678, pathMappings: [{ local: '{worktree}', remote: i.repoMount }] },
      healthcheck: { path: '/web/login', timeoutSec: 180 },
      composeTemplate: null,
    },
    postgres: pgSection(i, ['postgres']),
    production: {
      branch: i.productionBranch,
      slug: 'prod',
      backups: { dir: null, pattern: '*.zip', pick: 'latest', autoImport: false },
      postRestore: { sql: [], verifySql: null },
      updateModules: 'all',
    },
    stages: {
      development: { database: 'fresh', install: 'my', withDemo: true, onNewCommit: 'new' } satisfies BranchScope,
    },
    branchRules: [],
    autoAddBranches: 'none',
    connect: { adminPassword: null },
    extraSql: [],
    hooks: [],
  };
}
