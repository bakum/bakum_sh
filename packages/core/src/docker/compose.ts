import path from 'node:path';
import YAML from 'yaml';
import type { ProjectConfig, ResolvedBranchScope } from '@bm/shared';
import { renderDeep, type TemplateVars } from '../config/templates';
import type { ComposeTemplate } from '../config/compose-template';
import { toPosix } from '../util/paths';

export interface ComposeInput {
  cfg: ProjectConfig;
  scope: ResolvedBranchScope;
  branch: { id: number; name: string; slug: string; stage: string };
  build: { id: number; number: number; dbName: string; host: string; composeProject: string; debugPort: number | null };
  worktree: string;
  /** `{addonsPath}` computed from the build's code (`addonsPathVar`), when the command uses it. */
  addonsPath?: string;
  /** Traefik port in use, for the `bm.url` label. */
  proxyPort?: number | null;
  /** Server options for one-off runs (`serverBaseArgs` with the build's code), for the `bm.odoo.args` label (D52). */
  odooArgs?: string[];
  /** `runtime.composeTemplate`, already read (`readComposeTemplate`): merged over the generated file (D72). */
  template?: ComposeTemplate | null;
}

export const ODOO_SERVICE = 'odoo';

/** data_dir of Odoo inside the container: the parent of filestore.containerDir (docs/decisions.md D7). */
export const dataDirOf = (cfg: ProjectConfig): string => path.posix.dirname(cfg.runtime.filestore.containerDir);

/** Compose interpolates `$VAR`; every literal `$` (e.g. in `--db-filter=^db$`) must be doubled. */
const esc = (s: string): string => s.replace(/\$/g, '$$$$');
const escDeep = <T>(v: T): T => {
  if (typeof v === 'string') return esc(v) as T;
  if (Array.isArray(v)) return v.map(escDeep) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, escDeep(x)])) as T;
  return v;
};

export function templateVarsFor(i: ComposeInput): TemplateVars {
  return {
    project: i.cfg.id,
    branch: i.branch.name,
    slug: i.branch.slug,
    slug_: i.branch.slug.replace(/-/g, '_'),
    stage: i.branch.stage,
    build: i.build.number,
    db: i.build.dbName,
    host: i.build.host,
    debugPort: i.build.debugPort ?? undefined,
    worktree: toPosix(i.worktree),
    repoMount: i.cfg.runtime.repoMount,
    addonsPath: i.addonsPath,
  };
}

export function buildUrl(host: string, proxyPort: number | null): string {
  return `http://${host}${!proxyPort || proxyPort === 80 ? '' : `:${proxyPort}`}`;
}

/** Production, a protected branch setting or `repo.protectedBranches`: assistants only read such builds (D52). */
export function branchProtected(cfg: ProjectConfig, branch: string, stage: string, scope: { protected: boolean }): boolean {
  return stage === 'production' || scope.protected || cfg.repo.protectedBranches.includes(branch);
}

/**
 * Docker labels that mark ownership (spec 3): bm.project / bm.branch / bm.build (+ context). The context labels
 * (slug, url, protected, odoo.args) are what the assistant skill reads instead of guessing (D52).
 */
export function bmLabels(i: ComposeInput): Record<string, string> {
  return {
    'bm.project': i.cfg.id,
    'bm.branch': String(i.branch.id),
    'bm.branch.name': i.branch.name,
    'bm.build': String(i.build.id),
    'bm.build.number': String(i.build.number),
    'bm.stage': i.branch.stage,
    'bm.db': i.build.dbName,
    'bm.slug': i.branch.slug,
    'bm.url': buildUrl(i.build.host, i.proxyPort ?? null),
    'bm.protected': String(branchProtected(i.cfg, i.branch.name, i.branch.stage, i.scope)),
    ...(i.odooArgs ? { 'bm.odoo.args': i.odooArgs.join(' ') } : {}),
  };
}

/**
 * compose.yml of one build (spec 3): one `odoo` service in the project network, the branch worktree mounted
 * at repoMount, its own filestore mount, Traefik labels for `<host>`, debugpy published on 127.0.0.1 only.
 * Pure function (snapshot-tested).
 */
export function generateCompose(i: ComposeInput): string {
  const { cfg, scope } = i;
  const vars = templateVarsFor(i);
  const r = cfg.runtime;
  const router = i.build.composeProject.replace(/[^a-z0-9-]/g, '-');
  const env: Record<string, string> = { ...renderDeep(scope.env, vars) };
  // spec 9.3: USER / PASSWORD come from the postgres settings (used by the official Odoo entrypoint). PGPASSWORD is
  // for libpq when the command bypasses the entrypoint (debugpy, `docker exec`) and the conf has no password (D54).
  if (!('USER' in env)) env.USER = cfg.postgres.user;
  if (!('PASSWORD' in env) && cfg.postgres.password) env.PASSWORD = cfg.postgres.password;
  if (!('PGPASSWORD' in env) && cfg.postgres.password) env.PGPASSWORD = cfg.postgres.password;
  const volumes = [
    ...r.mounts.map((m) => ({ type: 'bind', source: toPosix(m.host), target: m.container, read_only: m.readOnly || undefined })),
    { type: 'bind', source: toPosix(i.worktree), target: r.repoMount },
    { type: 'bind', source: toPosix(r.filestore.hostDir), target: r.filestore.containerDir },
  ];
  const hc = r.healthcheck;
  const service = {
    image: scope.image,
    command: renderDeep(r.command, vars),
    environment: env,
    volumes,
    networks: [r.network],
    ...(i.build.debugPort ? { ports: [`127.0.0.1:${i.build.debugPort}:${r.debug.containerPort}`] } : {}),
    labels: {
      ...bmLabels(i),
      'traefik.enable': 'true',
      'traefik.docker.network': r.network,
      [`traefik.http.routers.${router}.rule`]: `Host(\`${i.build.host}\`)`,
      [`traefik.http.routers.${router}.entrypoints`]: 'web',
      [`traefik.http.routers.${router}.service`]: router,
      [`traefik.http.services.${router}.loadbalancer.server.port`]: '8069',
    },
    healthcheck: {
      test: ['CMD', 'python3', '-c', `import urllib.request; urllib.request.urlopen('http://localhost:8069${hc.path}', timeout=10)`],
      interval: '10s',
      timeout: '12s',
      retries: 3,
      start_period: '120s',
    },
    restart: 'unless-stopped',
    stop_grace_period: '20s',
  };
  const doc = applyTemplate(i, vars, {
    name: i.build.composeProject,
    services: { [ODOO_SERVICE]: escDeep(service) },
    networks: { [r.network]: { external: true, name: r.network } },
  });
  return (
    `# Generated by Odoo Branch Manager for ${cfg.id}/${i.branch.name} build #${i.build.number}. Do not edit: it is rewritten on each build.\n` +
    YAML.stringify(doc, { lineWidth: 0 })
  );
}

// ---------------------------------------------------------------------------------------------------------------
// runtime.composeTemplate (D72)

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
/** Lists that replace instead of adding up, as in compose's own merge of several files. */
const REPLACED_LISTS = new Set(['command', 'entrypoint', 'test']);

/** `environment` / `labels` may be written as `KEY=value` lists; the merge works on maps. */
function asMap(v: unknown): Obj {
  if (isObj(v)) return v;
  if (!Array.isArray(v)) return {};
  return Object.fromEntries(
    v.map((x) => {
      const s = String(x);
      const eq = s.indexOf('=');
      return eq < 0 ? [s, ''] : [s.slice(0, eq), s.slice(eq + 1)];
    }),
  );
}

/** Template over generated: maps merge (template wins), lists add up without duplicates, the rest is replaced. */
function mergeDeep(base: unknown, over: unknown, key = ''): unknown {
  if (isObj(base) && isObj(over)) {
    const out: Obj = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = k in base ? mergeDeep(base[k], v, k) : v;
    return out;
  }
  if (Array.isArray(base) && Array.isArray(over) && !REPLACED_LISTS.has(key)) {
    const seen = new Set(base.map((x) => JSON.stringify(x)));
    return [...base, ...over.filter((x) => !seen.has(JSON.stringify(x)))];
  }
  return over;
}

/** The project network on a service, whichever form (list or map) its `networks` has. */
function withNetwork(networks: unknown, net: string): unknown {
  if (isObj(networks)) return net in networks ? networks : { [net]: {}, ...networks };
  const list = Array.isArray(networks) ? networks.map(String) : [];
  return list.includes(net) ? list : [net, ...list];
}

/**
 * Merges `runtime.composeTemplate` into the generated file. The `odoo` service of the template is merged into the
 * build's service; other services are added with ownership labels (`bm.project` / `bm.branch` / `bm.build`,
 * `bm.service`), the project network and no Traefik route unless they set one. The app's labels (`bm.*`,
 * `traefik.*` of the build's route) and the project network always win. Template strings take the build variables
 * (`{db}`, `{slug}`…); `$` is left to compose interpolation.
 */
function applyTemplate(i: ComposeInput, vars: TemplateVars, doc: { name: string; services: Obj; networks: Obj }): Obj {
  if (!i.template) return doc;
  const tpl = renderDeep(i.template, vars);
  const net = i.cfg.runtime.network;
  const services: Obj = { ...doc.services };
  for (const [name, raw] of Object.entries(tpl.services)) {
    const svc: Obj = { ...raw };
    if ('labels' in svc) svc.labels = asMap(svc.labels);
    if ('environment' in svc) svc.environment = asMap(svc.environment);
    if (name === ODOO_SERVICE) {
      const base = services[ODOO_SERVICE] as Obj;
      const merged = mergeDeep(base, svc) as Obj;
      merged.labels = { ...(merged.labels as Obj), ...(base.labels as Obj) };
      merged.networks = withNetwork(merged.networks, net);
      services[ODOO_SERVICE] = merged;
      continue;
    }
    const own = { ...asMap(svc.labels) };
    for (const k of Object.keys(own)) if (k.startsWith('bm.')) delete own[k];
    services[name] = {
      restart: 'unless-stopped',
      ...svc,
      labels: {
        'traefik.enable': 'false',
        ...own,
        'bm.project': i.cfg.id,
        'bm.branch': String(i.branch.id),
        'bm.build': String(i.build.id),
        'bm.build.number': String(i.build.number),
        'bm.service': name,
      },
      ...('network_mode' in svc ? {} : { networks: withNetwork(svc.networks, net) }),
    };
  }
  return {
    name: doc.name,
    services,
    ...(Object.keys(tpl.volumes).length ? { volumes: tpl.volumes } : {}),
    networks: { ...tpl.networks, ...doc.networks },
  };
}

/**
 * Second compose file of the one-off runs (D60): the service healthcheck is disabled. A one-off inherits it, and with
 * --test-enable Odoo serves HTTP despite --no-http, so the checks hit the one-off's own server and fail on shutdown.
 * `docker compose run` has no --no-healthcheck.
 */
export const ONEOFF_OVERRIDE =
  '# Generated by Odoo Branch Manager: one-off Odoo CLI runs (docker compose run) of the build, without healthcheck.\n' +
  YAML.stringify({ services: { [ODOO_SERVICE]: { healthcheck: { disable: true } } } });

export const oneOffOverridePath = (composeFile: string): string => path.join(path.dirname(composeFile), 'compose.oneoff.yml');

/**
 * Arguments for the one-off Odoo CLI runs of the build steps (`docker compose run --rm`). `envNames` are passed as
 * `-e NAME` without a value: compose takes it from the docker CLI environment, so secrets stay off the command line.
 * The caller writes ONEOFF_OVERRIDE to `oneOffOverridePath(composeFile)`.
 */
export function oneOffArgs(composeFile: string, project: string, extraVolumes: string[], cmd: string[], envNames: string[] = []): string[] {
  return [
    'compose',
    '-p',
    project,
    '-f',
    composeFile,
    '-f',
    oneOffOverridePath(composeFile),
    'run',
    '--rm',
    '--no-deps',
    '-T',
    // One-off containers must never be routed by Traefik (same Host rule as the service).
    '-l',
    'traefik.enable=false',
    '-l',
    'bm.oneoff=true',
    ...extraVolumes.flatMap((v) => ['-v', v]),
    ...envNames.flatMap((n) => ['-e', n]),
    ODOO_SERVICE,
    ...cmd,
  ];
}
