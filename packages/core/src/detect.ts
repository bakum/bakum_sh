import fs from 'node:fs';
import path from 'node:path';
import type Docker from 'dockerode';
import { BmError, projectConfigSchema, type DetectResult } from '@bm/shared';
import * as git from './git';
import { docker } from './docker/client';
import { addonsDirsFrom, moduleRootsFrom, scanModules } from './modules';
import { demzPreset, genericPreset, type PresetInputs } from './config/presets';
import { isInside, samePath, toPosix } from './util/paths';

/** Secrets found during detection stay in Core; the renderer only learns that a password exists. */
const secrets = new Map<string, { password: string }>();

export function detectedPassword(repoPath: string): string | null {
  return secrets.get(repoPath.toLowerCase())?.password ?? null;
}

/** Project auto-detection (spec 8.1). Read-only: git queries, file reads, docker inspect. */
export async function detectProject(input: string, opts: { worktreesFallback: string; existingIds: string[] }): Promise<DetectResult> {
  const warnings: string[] = [];
  const repoPath = await git.topLevel(input);
  if (!repoPath) throw new BmError('NOT_A_REPO', `Папка «${input}» не является git-репозиторием. Выберите папку клона репозитория с модулями.`);

  const remotes = await git.remotes(repoPath);
  const remote = remotes.includes('origin') ? 'origin' : (remotes[0] ?? null);
  const remoteUrl = remote ? await git.remoteUrl(repoPath, remote) : null;
  const github = git.githubFromUrl(remoteUrl);
  if (!remote) warnings.push('У репозитория нет remote: fetch и ссылки на GitHub работать не будут.');
  const currentBranch = await git.currentBranch(repoPath);
  const branches = remote ? await git.listBranches(repoPath, remote) : [];
  const names = branches.map((b) => b.name);
  const productionCandidate =
    ['master', 'main'].find((n) => names.includes(n)) ??
    names.filter((n) => /^\d+\.\d+$/.test(n)).sort((a, b) => parseFloat(b) - parseFloat(a))[0] ??
    null;

  const modules = scanModules(repoPath, 4);
  const moduleRoots = moduleRootsFrom(modules);
  const addonsDirs = addonsDirsFrom(modules);
  if (!modules.length) warnings.push('В репозитории не найдено ни одного модуля Odoo (__manifest__.py на глубине до 4).');
  const modulesToInstall = findModuleList(repoPath);

  // Odoo project folder above the repo: docker-compose.yml / Dockerfile / config/odoo.conf
  let projectRoot: string | null = null;
  let dir = path.dirname(repoPath);
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
  try {
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
  } else {
    warnings.push('Не найден контейнер Odoo, монтирующий этот репозиторий: образ, сеть и монтирования нужно указать вручную.');
  }

  secrets.set(repoPath.toLowerCase(), { password: pgPassword });

  const repoName = path.basename(repoPath);
  const isDemz = github?.toLowerCase() === 'demz-ua/demz-odoo' || /demz-odoo/i.test(remoteUrl ?? '');
  const baseId = isDemz ? 'demz' : repoName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 20) || 'project';
  let id = baseId;
  for (let i = 2; opts.existingIds.includes(id); i++) id = `${baseId}-${i}`;

  const inputs: PresetInputs = {
    id,
    name: isDemz ? 'DEMZ Odoo 19' : repoName,
    repoPath,
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
    addonsDirs,
    debugpy: !!command?.some((a) => a === 'debugpy'),
    productionBranch: productionCandidate ?? currentBranch ?? 'main',
    odooVersion: odooContainer?.Config.Env?.find((e) => e.startsWith('ODOO_VERSION='))?.split('=')[1] ?? '19.0',
  };

  return {
    repoPath,
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
    suggestedPreset: isDemz ? 'demz' : 'generic',
    warnings,
    proposals: {
      demz: projectConfigSchema.parse(demzPreset(inputs)),
      generic: projectConfigSchema.parse(genericPreset(inputs)),
    },
  };
}

function firstExisting(root: string, rels: string[]): string | null {
  for (const r of rels) if (fs.existsSync(path.join(root, r))) return `${root}/${r}`;
  return null;
}

function findModuleList(repo: string): string | null {
  const candidates: string[] = [];
  const walk = (rel: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(repo, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isFile() && /^modules?_to_install\.txt$/i.test(e.name)) candidates.push(r);
      else if (e.isDirectory() && depth < 2 && !e.name.startsWith('.')) walk(r, depth + 1);
    }
  };
  walk('', 0);
  return candidates.sort((a, b) => a.split('/').length - b.split('/').length)[0] ?? null;
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
