import fs from 'node:fs';
import path from 'node:path';
import type Docker from 'dockerode';
import { BmError, ODOO_VERSIONS, projectConfigSchema, type DetectResult } from '@bm/shared';
import * as git from './git';
import { docker } from './docker/client';
import { manifestVersion, moduleRootsFrom, modulesFromTree } from './modules';
import { repoNameFromUrl } from './services/repo';
import { demzPreset, genericPreset, odooPreset, stackAddons, type PresetInputs } from './config/presets';
import { isInside, samePath, toPosix } from './util/paths';

/** Secrets found during detection stay in Core; the renderer only learns that a password exists. */
const secrets = new Map<string, { password: string }>();

export function detectedPassword(mirrorDir: string): string | null {
  return secrets.get(mirrorDir.toLowerCase())?.password ?? null;
}

/**
 * Project auto-detection (spec 8.1, D33). Read-only. Modules, the module list file and the Odoo series come from the
 * app's mirror (tree of the production candidate); the user's own clone, when given, is only used to find the Odoo
 * container that mounts it (image, network, mounts, Postgres) and the project folder around it (DEMZ).
 */
export async function detectProject(
  input: { mirror: string; url: string; folder?: string | null },
  opts: {
    worktreesFallback: string;
    existingIds: string[];
    /** `<dataDir>/filestore` — filestore of «Odoo in Docker» projects. */
    filestoreRoot: string;
    /** Free port for a managed Postgres (allocatePgPort). */
    pgPort: number;
    odoo?: { version?: string; enterprisePath?: string | null };
  },
): Promise<DetectResult> {
  const mirror = toPosix(input.mirror);
  if (!fs.existsSync(mirror)) throw new BmError('NO_DIR', `Копия репозитория «${mirror}» не найдена: загрузите репозиторий заново.`);
  const warnings: string[] = [];
  const remote = 'origin';
  const remoteUrl = input.url;
  const github = git.githubFromUrl(remoteUrl);
  const folder = input.folder ? (await git.folderRemoteUrl(input.folder)).top : null;
  const currentBranch = folder ? await git.currentBranch(folder) : null;
  const branches = await git.listBranches(mirror, remote);
  const names = branches.map((b) => b.name);
  const productionCandidate =
    ['master', 'main'].find((n) => names.includes(n)) ??
    names.filter((n) => /^\d+\.\d+$/.test(n)).sort((a, b) => parseFloat(b) - parseFloat(a))[0] ??
    null;
  const treeBranch = productionCandidate ?? (currentBranch && names.includes(currentBranch) ? currentBranch : names[0]) ?? null;
  const treeRef = treeBranch ? `refs/remotes/${remote}/${treeBranch}` : null;
  if (!treeRef) warnings.push('В репозитории нет ни одной ветки.');
  const files = treeRef ? await git.lsTree(mirror, treeRef) : [];

  const modules = modulesFromTree(files)
    .filter((m) => m.dir.split('/').length <= 4 && !m.dir.split('/').some((p) => p.startsWith('.')))
    .sort((a, b) => a.dir.localeCompare(b.dir));
  const moduleRoots = moduleRootsFrom(modules);
  if (!modules.length) warnings.push('В репозитории не найдено ни одного модуля Odoo (__manifest__.py на глубине до 4).');
  const modulesToInstall = findModuleList(files);
  const repoPath = folder;

  // Odoo project folder above the repo: docker-compose.yml / Dockerfile / config/odoo.conf
  let projectRoot: string | null = null;
  let dir = repoPath ? path.dirname(repoPath) : '';
  for (let i = 0; i < 3 && dir && dir !== path.dirname(dir); i++, dir = path.dirname(dir)) {
    if (['docker-compose.yml', 'compose.yml', 'Dockerfile'].some((f) => fs.existsSync(path.join(dir, f)))) {
      projectRoot = toPosix(dir);
      break;
    }
  }
  const composeFile = projectRoot ? firstExisting(projectRoot, ['docker-compose.yml', 'compose.yml']) : null;
  const dockerfile = projectRoot ? firstExisting(projectRoot, ['Dockerfile']) : null;
  const odooConf = projectRoot ? firstExisting(projectRoot, ['config/odoo.conf', 'odoo.conf', 'etc/odoo.conf']) : null;

  // Running Odoo container that mounts the repo (or its parent) → image, network, mounts, repoMount.
  let image: string | null = null;
  let network: string | null = null;
  let repoMount: string | null = null;
  let command: string[] | null = null;
  let mounts: DetectResult['mounts'] = [];
  let filestoreHostDir: string | null = null;
  let odooContainer: Docker.ContainerInspectInfo | null = null;
  let pg: DetectResult['postgres'] = null;
  let pgPassword = '';
  if (repoPath) try {
    // Several containers may mount the repo; prefer an Odoo container of the same compose project, running.
    let best: { score: number; info: Docker.ContainerInspectInfo; mount: string } | null = null;
    const list = await docker.listContainers({ all: true });
    for (const c of list) {
      const info = await docker.getContainer(c.Id).inspect();
      for (const m of info.Mounts) {
        if (m.Type !== 'bind' || !m.Source) continue;
        const src = toPosix(m.Source);
        if (!(samePath(src, repoPath) || isInside(src, repoPath))) continue;
        const env = info.Config.Env ?? [];
        const odooLike =
          env.some((e) => e.startsWith('ODOO_VERSION=')) || /odoo/i.test(info.Config.Image) || (info.Config.Cmd ?? []).some((a) => /odoo/.test(a));
        if (!odooLike) continue;
        const wd = info.Config.Labels?.['com.docker.compose.project.working_dir'];
        const score = 5 + (projectRoot && wd && samePath(wd, projectRoot) ? 10 : 0) + (info.State.Running ? 3 : 0);
        if (!best || score > best.score) best = { score, info, mount: `${m.Destination}${repoPath.slice(src.length)}`.replace(/\/+$/, '') };
      }
    }
    if (best) {
      odooContainer = best.info;
      repoMount = best.mount;
    }
  } catch (err) {
    warnings.push(`Docker недоступен: ${(err as Error).message}. Образ, сеть и Postgres нужно указать вручную.`);
  }

  if (odooContainer) {
    image = odooContainer.Config.Image;
    const nets = Object.keys(odooContainer.NetworkSettings.Networks ?? {});
    network = nets.find((n) => n !== 'bridge') ?? nets[0] ?? null;
    command = odooContainer.Config.Cmd ?? null;
    for (const m of odooContainer.Mounts) {
      if (m.Type !== 'bind' || !m.Source) continue;
      if (m.Destination === '/var/lib/odoo') {
        filestoreHostDir = toPosix(m.Source);
        continue;
      }
      // Shared host folders are mounted read-only into builds: builds must not write into the project (D8).
      mounts.push({ host: toPosix(m.Source), container: m.Destination, readOnly: true });
    }
    const env = Object.fromEntries((odooContainer.Config.Env ?? []).map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
    const internalHost = env.HOST ?? 'db';
    const user = env.USER ?? readConf(odooConf, 'db_user') ?? 'odoo';
    pgPassword = env.PASSWORD ?? readConf(odooConf, 'db_password') ?? '';
    // Postgres container in the same network
    try {
      const list = await docker.listContainers({ all: true });
      for (const c of list) {
        const nets = Object.keys(c.NetworkSettings?.Networks ?? {});
        if (!network || !nets.includes(network)) continue;
        if (!/postgres|pgvector|postgis/i.test(c.Image)) continue;
        const port = c.Ports.find((p) => p.PrivatePort === 5432 && p.PublicPort)?.PublicPort ?? null;
        const service = c.Labels['com.docker.compose.service'];
        const name = (c.Names[0] ?? '').replace(/^\//, '');
        pg = {
          container: name,
          image: c.Image,
          host: 'localhost',
          port: port ?? 5432,
          internalHost: service === internalHost || name === internalHost ? internalHost : (service ?? name),
          user,
          hasPassword: !!pgPassword,
        };
        if (!port) warnings.push(`Postgres «${name}» не публикует порт на хост: приложению нужен доступ к нему с localhost.`);
        if (c.State !== 'running') warnings.push(`Контейнер Postgres «${name}» не запущен.`);
        break;
      }
    } catch {
      /* reported above */
    }
    if (!pg) warnings.push(`В сети ${network ?? '?'} не найден контейнер Postgres.`);
  } else if (!isDemzUrl(remoteUrl, github)) {
    warnings.push(
      repoPath
        ? 'Не найден контейнер Odoo, монтирующий этот репозиторий. Пресет «Odoo в Docker» поднимет Odoo и Postgres сам; для Generic образ, сеть и Postgres нужно указать вручную.'
        : 'Пресет «Odoo в Docker» поднимет Odoo и Postgres сам. Для Generic укажите папку своего клона, который смонтирован в ваш контейнер Odoo, или впишите образ, сеть и Postgres вручную.',
    );
  }

  secrets.set(mirror.toLowerCase(), { password: pgPassword });

  // Odoo series: manifest versions, else the production branch name, else ODOO_VERSION of the detected container.
  const containerVersion = odooContainer?.Config.Env?.find((e) => e.startsWith('ODOO_VERSION='))?.split('=')[1] || null;
  const manifests = treeRef ? await Promise.all(modules.slice(0, 40).map((m) => git.showFile(mirror, treeRef, `${m.dir}/__manifest__.py`))) : [];
  const seriesFound = detectSeries(manifests, productionCandidate) ?? (containerVersion?.match(/^\d+\.0/)?.[0] ?? null);

  const repoName = repoNameFromUrl(remoteUrl);
  const isDemz = isDemzUrl(remoteUrl, github);
  const baseId = isDemz ? 'demz' : repoName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 20) || 'project';
  let id = baseId;
  for (let i = 2; opts.existingIds.includes(id); i++) id = `${baseId}-${i}`;

  const inputs: PresetInputs = {
    id,
    name: isDemz ? 'DEMZ Odoo 19' : repoName,
    repo: { url: remoteUrl, mirrorDir: mirror, localFolder: folder },
    github,
    remote: remote ?? 'origin',
    projectRoot,
    worktreesDir: projectRoot ? `${projectRoot}/worktrees` : toPosix(opts.worktreesFallback),
    moduleRoots,
    modulesToInstall,
    image: image ?? 'odoo:19',
    network: network ?? 'bridge',
    repoMount: repoMount ?? `/mnt/repositories/${repoName}`,
    mounts,
    filestoreHostDir: filestoreHostDir ?? (projectRoot ? `${projectRoot}/data/filestore` : `${toPosix(opts.worktreesFallback)}/../filestore/${id}`),
    postgres: {
      host: pg?.host ?? 'localhost',
      port: pg?.port ?? 5432,
      internalHost: pg?.internalHost ?? 'db',
      user: pg?.user ?? 'odoo',
      password: '',
      protectedContainers: [odooContainer?.Name.replace(/^\//, ''), pg?.container].filter((x): x is string => !!x),
    },
    // New projects get the app's own Postgres; the image of the detected one keeps its extensions (pgvector…).
    managedPg: { image: pg?.image ?? 'postgres:16', port: opts.pgPort },
    stackAddons: stackAddons(readConf(odooConf, 'addons_path'), repoMount ?? `/mnt/repositories/${repoName}`),
    debugpy: !!command?.some((a) => a === 'debugpy'),
    productionBranch: productionCandidate ?? currentBranch ?? 'main',
    // Build commands depend on the version (demo flags, D38): the stack's image, else the modules' series.
    odooVersion: containerVersion ?? seriesFound ?? '19.0',
  };

  const supported = !!seriesFound && (ODOO_VERSIONS as readonly string[]).includes(seriesFound);
  const odooVersion = opts.odoo?.version ?? (supported ? seriesFound! : ODOO_VERSIONS[0]);
  if (seriesFound && !supported) {
    warnings.push(`Модули репозитория рассчитаны на Odoo ${seriesFound}; пресет «Odoo в Docker» поддерживает ${ODOO_VERSIONS.join(', ')}.`);
  } else if (seriesFound && seriesFound !== odooVersion) {
    warnings.push(`Модули репозитория рассчитаны на Odoo ${seriesFound}, а выбрана Odoo ${odooVersion}.`);
  }
  let enterpriseDir: string | null = null;
  if (opts.odoo?.enterprisePath) {
    const dir = toPosix(path.resolve(opts.odoo.enterprisePath));
    if (!fs.existsSync(path.join(dir, 'web_enterprise', '__manifest__.py'))) {
      warnings.push(`В папке Enterprise ${dir} нет модуля web_enterprise: укажите корень репозитория odoo/enterprise нужной версии.`);
    } else {
      enterpriseDir = dir;
      const v = manifestVersion(readText(path.join(dir, 'web_enterprise', '__manifest__.py')));
      const entSeries = v?.match(/^\d+\.0/)?.[0];
      if (entSeries && entSeries !== odooVersion) warnings.push(`Enterprise в ${dir} — версии ${entSeries}, а выбрана Odoo ${odooVersion}.`);
    }
  }
  const odooProposal = odooPreset({
    id,
    name: inputs.name,
    repo: inputs.repo,
    repoName,
    github,
    remote: remote ?? 'origin',
    worktreesDir: inputs.worktreesDir,
    filestoreHostDir: toPosix(path.join(opts.filestoreRoot, id)),
    moduleRoots,
    modulesToInstall,
    productionBranch: inputs.productionBranch,
    odooVersion,
    pgPort: opts.pgPort,
    enterpriseDir,
  });

  return {
    mirrorDir: mirror,
    url: remoteUrl,
    localFolder: folder,
    isGitRepo: true,
    remote,
    remoteUrl,
    github,
    currentBranch,
    branches: names,
    productionCandidate,
    moduleRoots,
    moduleCount: modules.length,
    modulesToInstall,
    projectRoot,
    composeFile,
    dockerfile,
    odooConf,
    image,
    network,
    repoMount,
    mounts,
    command,
    postgres: pg,
    odooVersion,
    suggestedPreset: isDemz ? 'demz' : odooContainer ? 'generic' : 'odoo',
    warnings,
    proposals: {
      demz: projectConfigSchema.parse(demzPreset(inputs)),
      generic: projectConfigSchema.parse(genericPreset(inputs)),
      odoo: projectConfigSchema.parse(odooProposal),
    },
  };
}

function isDemzUrl(remoteUrl: string | null, github: string | null): boolean {
  return github?.toLowerCase() === 'demz-ua/demz-odoo' || /demz-odoo/i.test(remoteUrl ?? '');
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Odoo series of the repository: the most frequent «NN.0» prefix of manifest versions (up to 40 manifests),
 * otherwise a production branch named like a series.
 */
export function detectSeries(manifests: (string | null)[], productionCandidate: string | null): string | null {
  const counts = new Map<string, number>();
  for (const text of manifests.slice(0, 40)) {
    const v = manifestVersion(text);
    const s = v?.match(/^(\d{2})\.0\./)?.[0].slice(0, -1);
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (best) return best;
  return productionCandidate && /^\d{2}\.0$/.test(productionCandidate) ? productionCandidate : null;
}

function firstExisting(root: string, rels: string[]): string | null {
  for (const r of rels) if (fs.existsSync(path.join(root, r))) return `${root}/${r}`;
  return null;
}

/** `modules_to_install.txt` (or `module_to_install.txt`) at most two directories deep, the shallowest one. */
function findModuleList(files: string[]): string | null {
  return (
    files
      .filter((f) => /^modules?_to_install\.txt$/i.test(f.split('/').pop()!) && f.split('/').length <= 3 && !f.split('/').some((p) => p.startsWith('.')))
      .sort((a, b) => a.split('/').length - b.split('/').length)[0] ?? null
  );
}

/** Reads `key = value` from odoo.conf (never .env). */
function readConf(file: string | null, key: string): string | null {
  if (!file) return null;
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`).exec(line);
      if (m) return m[1]!;
    }
  } catch {
    /* missing */
  }
  return null;
}

/** Password found by the most recent detection (the wizard may change the repo path before creating). */
export function lastDetectedPassword(): string | null {
  const all = [...secrets.values()];
  return all[all.length - 1]?.password || null;
}
