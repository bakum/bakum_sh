import fs from 'node:fs';
import path from 'node:path';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';
import { execa } from 'execa';
import { BmError, BUILD_STEPS, type BuildStepName, type ChangedModules } from '@bm/shared';
import type { Ctx } from '../context';
import { branches, builds, jobs, type BranchRow } from '../db/schema';
import { getQueue } from '../jobs/queue';
import { buildRow, buildUrl, listBuilds, liveBuild, toBuildView } from '../builds/view';
import { requestBuildChecked } from '../builds/request';
import { listBackups } from '../builds/backups';
import { serviceContainer } from '../builds/pipeline';
import { codeVars, serverBaseArgs } from '../builds/odoo-cli';
import { resolveBranchScope } from '../config/effective';
import { renderDeep } from '../config/templates';
import * as git from '../git';
import { assertBranchFolder, codeSource, FOLDER_SAFE_JOBS } from '../git/worktrees';
import * as pg from '../pg';
import { changedModules, modulesFromTree, parseModuleList, splitInstallUpdate } from '../modules';
import { branchByName, branchRow } from './branch-rows';
import { mustBranch } from './branches';
import { audit } from './audit';
import { buildUsers, connectAs } from './connect-as';
import { bus } from '../events';
import { clearPause } from '../builds/triggers';
import { toPosix } from '../util/paths';
import { log } from '../util/logger';
import { runtimeState } from '../state';

function mustBuild(ctx: Ctx, id: number) {
  const b = buildRow(ctx, id);
  if (!b) throw new BmError('NO_BUILD', 'Сборка не найдена');
  return b;
}

function view(ctx: Ctx, id: number) {
  const b = mustBuild(ctx, id);
  const br = branchRow(ctx, b.branchId);
  const cfg = ctx.store.get(b.projectId)?.config;
  const scope = cfg && br ? resolveBranchScope(cfg, br.name, br.stage, br.overrides).scope : null;
  return toBuildView(ctx, b, { branchName: br?.name ?? '?', dropAfterDays: scope?.dropAfterDays, lastActiveAt: br?.lastActiveAt });
}

async function retry(ctx: Ctx, buildId: number, fromStep: string) {
  const b = mustBuild(ctx, buildId);
  if (b.status !== 'failed') throw new BmError('BAD_STATE', 'Повторить можно только упавшую сборку');
  if (!(BUILD_STEPS as readonly string[]).includes(fromStep)) throw new BmError('BAD_STEP', `Неизвестный шаг ${fromStep}`);
  const active = ctx.db.select().from(builds).where(and(eq(builds.branchId, b.branchId), inArray(builds.status, ['queued', 'building']))).get();
  if (active) throw new BmError('BUILD_ACTIVE', `У ветки уже идёт сборка #${active.number}`);
  await assertBranchFolder(ctx, b.branchId);
  const idx = BUILD_STEPS.indexOf(fromStep as BuildStepName);
  const steps = b.steps.map((s, i) => (i >= idx ? { ...s, status: 'pending' as const, startedAt: null, finishedAt: null, note: undefined } : s));
  // The previous live build may have changed since (e.g. another build became live).
  const live = liveBuild(ctx, b.branchId);
  ctx.db
    .update(builds)
    .set({ status: 'queued', steps, errorMessage: null, finishedAt: null, previousBuildId: b.kind === 'update' ? b.previousBuildId : (live?.id ?? null) })
    .where(eq(builds.id, b.id))
    .run();
  const orig = ctx.db.select().from(jobs).where(eq(jobs.buildId, b.id)).orderBy(desc(jobs.id)).get();
  const jobId = getQueue().enqueue(b.trigger === 'import_backup' ? 'import_backup' : 'build', { projectId: b.projectId, branchId: b.branchId, buildId: b.id }, {
    ...(orig?.params ?? {}),
    fromStep,
  });
  audit(ctx, { projectId: b.projectId, action: 'build.retry', target: `${b.composeProject}#${b.number}`, params: { fromStep } });
  bus.emit({ type: 'build.changed', projectId: b.projectId, branchId: b.branchId, buildId: b.id });
  return { jobId };
}

/** Changed modules of the branch HEAD relative to the live build (Tools tab, spec 8.7). */
async function changedModulesPreview(ctx: Ctx, branchId: number): Promise<ChangedModules> {
  const br = mustBranch(ctx, branchId);
  const cfg = ctx.store.require(br.projectId);
  const scope = resolveBranchScope(cfg, br.name, br.stage, br.overrides).scope;
  const live = liveBuild(ctx, br.id);
  const src = codeSource(cfg, br, scope);
  const to = src.kind === 'folder' ? await git.headSha(src.dir) : (br.lastSeenRemoteSha ?? (await git.remoteSha(src.repo, cfg.repo.remote, br.name)));
  const from = live?.commitSha ?? null;
  const extra = src.kind === 'folder' ? await git.uncommittedFiles(src.dir) : [];
  if (!from || !to || (from === to && !extra.length) || !(await git.revParse(src.repo, from))) return { from, to, files: 0, modules: [] };
  const files = [...new Set([...(await git.diffNames(src.repo, from, to)), ...extra])];
  const toMods = modulesFromTree(await git.lsTree(src.repo, to));
  const fromMods = modulesFromTree(await git.lsTree(src.repo, from));
  const ch = changedModules(files, toMods, fromMods, cfg.repo.moduleRoots);
  let installed = new Set<string>();
  try {
    installed = await pg.installedModules(cfg.postgres, live!.dbName);
  } catch {
    /* DB unavailable */
  }
  const wantedText = cfg.repo.modulesToInstall ? await git.showFile(src.repo, to, cfg.repo.modulesToInstall) : null;
  const s = splitInstallUpdate(ch.changed.map((m) => m.name), installed, new Set(wantedText ? parseModuleList(wantedText) : []));
  const dirOf = new Map(toMods.map((m) => [m.name, m.dir]));
  return {
    from,
    to,
    files: files.length,
    modules: [
      ...s.update.map((n) => ({ name: n, path: dirOf.get(n) ?? '', action: 'update' as const })),
      ...s.install.map((n) => ({ name: n, path: dirOf.get(n) ?? '', action: 'install' as const })),
      ...s.none.map((n) => ({ name: n, path: dirOf.get(n) ?? '', action: 'none' as const })),
      ...ch.removed.map((m) => ({ name: m.name, path: m.dir, action: 'removed' as const })),
    ],
  };
}

/** Folder with the code of a branch: the user's folder (Development setting) or the worktree of the mirror (D33). */
function codeDir(ctx: Ctx, br: BranchRow): string | null {
  const cfg = ctx.store.require(br.projectId);
  return codeSource(cfg, br, resolveBranchScope(cfg, br.name, br.stage, br.overrides).scope).dir;
}

/** debugpy attach configuration (spec 8.9 Tools → Debug) with pathMappings from the project settings. */
function launchConfig(ctx: Ctx, buildId: number) {
  const b = mustBuild(ctx, buildId);
  const br = branchRow(ctx, b.branchId);
  const cfg = ctx.store.require(b.projectId);
  const dir = br ? codeDir(ctx, br) : null;
  const worktree = dir ? toPosix(dir) : '${workspaceFolder}';
  const mappings = renderDeep(cfg.runtime.debug.pathMappings, { worktree, repoMount: cfg.runtime.repoMount, project: cfg.id });
  return {
    name: `Attach ${br?.name ?? b.composeProject} (${cfg.id}:${b.debugPort})`,
    type: 'debugpy',
    request: 'attach',
    connect: { host: '127.0.0.1', port: b.debugPort ?? 0 },
    pathMappings: mappings.map((m) => ({ localRoot: m.local, remoteRoot: m.remote })),
    justMyCode: false,
  };
}

function writeLaunchJson(ctx: Ctx, buildId: number) {
  const b = mustBuild(ctx, buildId);
  const br = branchRow(ctx, b.branchId);
  const dir = br ? codeDir(ctx, br) : null;
  if (!br || !dir) throw new BmError('NO_WORKTREE', 'У ветки нет worktree');
  const conf = launchConfig(ctx, buildId);
  const file = path.join(dir, '.vscode', 'launch.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{\n  "version": "0.2.0",\n  "configurations": []\n}\n';
  const parsed = (parseJsonc(text) ?? {}) as { configurations?: { name?: string }[] };
  const list = parsed.configurations ?? [];
  const idx = list.findIndex((c) => c.name === conf.name || (c.name ?? '').startsWith(`Attach ${br.name} (`));
  const fmt = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
  // jsonc-parser edits keep existing comments and formatting (spec 8.9).
  if (!parsed.configurations) text = applyEdits(text, modify(text, ['configurations'], [], fmt));
  text = applyEdits(text, modify(text, ['configurations', idx >= 0 ? idx : list.length], conf, { ...fmt, isArrayInsertion: idx < 0 }));
  fs.writeFileSync(file, text, 'utf8');
  const gi = path.join(dir, '.gitignore');
  const ignored = fs.existsSync(gi) && /^\/?\.vscode\/?\s*$/m.test(fs.readFileSync(gi, 'utf8'));
  audit(ctx, { projectId: b.projectId, action: 'debug.launchJson', target: file });
  return { path: toPosix(file), gitignoreWarning: !ignored };
}

async function credentials(ctx: Ctx, buildId: number) {
  const b = mustBuild(ctx, buildId);
  const cfg = ctx.store.require(b.projectId);
  let login: string | null = null;
  try {
    const rows = await pg.query<{ login: string }>(
      cfg.postgres,
      b.dbName,
      "SELECT login FROM res_users WHERE id = (SELECT res_id FROM ir_model_data WHERE module = 'base' AND name = 'user_admin')",
    );
    login = rows[0]?.login ?? null;
  } catch {
    login = null;
  }
  const password = b.dbSource === 'fresh' ? 'admin' : (cfg.connect.adminPassword ?? null);
  return { login, password, url: buildUrl(b.host, ctx.proxyPort ?? ctx.store.app.proxyPort) };
}

/** Terminal command (spec 8.9 Shell): Windows Terminal if present, otherwise cmd — argument arrays only. */
async function openTerminal(ctx: Ctx, title: string, argv: string[], env: Record<string, string> = {}): Promise<string | undefined> {
  const pref = ctx.store.app.desktop.terminal;
  const wtOk = pref === 'wt' && (await execa('where', ['wt'], { reject: false, windowsHide: true })).exitCode === 0;
  const opts = { detached: true, stdio: 'ignore' as const, reject: false, windowsHide: false, env };
  if (wtOk) {
    execa('wt', ['new-tab', '--title', title, ...argv], opts).unref();
    return undefined;
  }
  if (pref === 'git-bash') {
    const bash = 'C:/Program Files/Git/git-bash.exe';
    if (fs.existsSync(bash)) {
      execa(bash, ['-c', argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ') + '; read -p "Enter для выхода"'], opts).unref();
      return undefined;
    }
  }
  execa('cmd.exe', ['/c', 'start', title, ...argv], opts).unref();
  return pref === 'wt' ? 'Windows Terminal не найден — открыт cmd' : undefined;
}

/** shell.open targets served by the build's containers / Traefik (D63). */
const DOCKER_TARGETS: ReadonlySet<string> = new Set(['browser', 'browser-debug', 'terminal', 'bash', 'odoo-shell', 'psql']);

async function shellOpen(ctx: Ctx, p: { buildId?: number; branchId?: number; target: string }): Promise<{ ok: true; detail?: string }> {
  const b = p.buildId ? mustBuild(ctx, p.buildId) : null;
  const br = p.branchId ? mustBranch(ctx, p.branchId) : b ? branchRow(ctx, b.branchId) : null;
  const pid = b?.projectId ?? br?.projectId;
  const cfg = pid ? ctx.store.require(pid) : null;
  const port = ctx.proxyPort ?? ctx.store.app.proxyPort;
  const needBuild = () => {
    if (!b) throw new BmError('NO_BUILD', 'Нет сборки');
    return b;
  };
  if (DOCKER_TARGETS.has(p.target) && !runtimeState.docker.ok) {
    throw new BmError('DOCKER_DOWN', 'Docker Desktop не запущен: запустите его (кнопка «Запустить» вверху окна) и повторите');
  }
  switch (p.target) {
    case 'browser':
      ctx.toMain({ kind: 'openExternal', url: buildUrl(needBuild().host, port) });
      return { ok: true };
    case 'browser-debug':
      ctx.toMain({ kind: 'openExternal', url: `${buildUrl(needBuild().host, port)}/web?debug=1` });
      return { ok: true };
    case 'github':
      if (!cfg?.repo.github) throw new BmError('NO_GITHUB', 'repo.github не задан');
      ctx.toMain({ kind: 'openExternal', url: `https://github.com/${cfg.repo.github}/tree/${br?.name ?? ''}` });
      return { ok: true };
    case 'mails':
      throw new BmError('POSTPONED', 'Mailpit в сборках отложен (docs/decisions.md D43): письма из сборок наружу не уходят.');
    case 'logs-dir':
      ctx.toMain({ kind: 'openPath', path: ctx.logsDir });
      return { ok: true };
    case 'build-log':
      if (!b?.logPath) throw new BmError('NO_LOG', 'Нет лога сборки');
      ctx.toMain({ kind: 'openPath', path: b.logPath });
      return { ok: true };
    case 'explorer':
    case 'editor':
    case 'editor-cursor': {
      const dir = br ? codeDir(ctx, br) : null;
      if (!dir || !fs.existsSync(dir)) throw new BmError('NO_WORKTREE', 'Worktree ветки ещё не создан: Editor → «Создать worktree» или Rebuild');
      if (p.target === 'explorer') {
        ctx.toMain({ kind: 'openPath', path: dir });
        return { ok: true };
      }
      const exe = p.target === 'editor-cursor' ? 'cursor' : ctx.store.app.desktop.editor;
      const target = path.resolve(dir);
      const r = await execa(exe, [target], { reject: false, windowsHide: true, detached: true, stdio: 'ignore' });
      log().info({ exe, target, exitCode: r.exitCode }, 'editor opened');
      if (r.failed && r.exitCode !== 0) throw new BmError('NO_EDITOR', `Не удалось запустить «${exe}». Укажите путь к CLI редактора в Settings → Приложение → Редактор.`);
      return { ok: true };
    }
    case 'terminal':
    case 'bash':
    case 'odoo-shell': {
      const c = await serviceContainer(needBuild());
      if (!c) throw new BmError('NOT_RUNNING', 'Контейнер сборки не найден: запустите сборку (Start)');
      const argv =
        p.target === 'odoo-shell'
          ? ['docker', 'exec', '-it', c.name, 'odoo', 'shell', ...serverBaseArgs(cfg!, codeVars(cfg!, br ? codeDir(ctx, br) : null)), '-d', b!.dbName, '--no-http']
          : ['docker', 'exec', '-it', c.name, 'bash'];
      return { ok: true, detail: await openTerminal(ctx, `${br?.name ?? ''} ${p.target}`, argv) };
    }
    case 'psql': {
      const bb = needBuild();
      // One-off psql client in the project network; the password goes via the environment, not the command line.
      const argv = ['docker', 'run', '--rm', '-it', '--network', cfg!.runtime.network, '-e', 'PGPASSWORD', cfg!.runtime.image, 'psql', '-h', cfg!.postgres.internalHost, '-U', cfg!.postgres.user, bb.dbName];
      return { ok: true, detail: await openTerminal(ctx, `psql ${bb.dbName}`, argv, { PGPASSWORD: cfg!.postgres.password }) };
    }
    default:
      throw new BmError('BAD_TARGET', p.target);
  }
}

export function registerBuildHandlers(ctx: Ctx): void {
  const q = () => getQueue();
  const enqueueFor = async (type: 'drop' | 'start' | 'stop' | 'restart' | 'apply_config' | 'modules' | 'tests', buildId: number, params: Record<string, unknown> = {}) => {
    const b = mustBuild(ctx, buildId);
    // Refused at once while another branch is open in the user's folder: no job, nothing in History (D59).
    if (!FOLDER_SAFE_JOBS.has(type)) await assertBranchFolder(ctx, b.branchId, { usable: type !== 'drop' });
    return { jobId: q().enqueue(type, { projectId: b.projectId, branchId: b.branchId, buildId: b.id }, { number: b.number, ...params }) };
  };
  ctx.rpc.register({
    'builds.list': (p) => listBuilds(ctx, p),
    'builds.get': (p) => view(ctx, p.buildId),
    'builds.rebuild': async (p) => {
      clearPause(ctx, p.branchId);
      return { jobId: await requestBuildChecked(ctx, p.branchId, { trigger: p.trigger ?? 'rebuild', kind: 'new' }) };
    },
    'builds.update': async (p) => ({ jobId: await requestBuildChecked(ctx, p.branchId, { trigger: 'manual', kind: 'update' }) }),
    'builds.retry': (p) => retry(ctx, p.buildId, p.fromStep),
    'builds.drop': (p) => {
      const b = mustBuild(ctx, p.buildId);
      if (b.status === 'queued' || b.status === 'building') throw new BmError('BUILD_ACTIVE', 'Сборка ещё идёт: сначала отмените задачу');
      if (b.status === 'dropped') throw new BmError('BAD_STATE', 'Сборка уже отброшена');
      return enqueueFor('drop', p.buildId);
    },
    'builds.action': (p) => {
      const b = mustBuild(ctx, p.buildId);
      if (!b.live) throw new BmError('BAD_STATE', 'Действие доступно только для живой сборки');
      return enqueueFor(p.action === 'apply-config' ? 'apply_config' : p.action, p.buildId);
    },
    'builds.stopAll': async () => {
      const live = ctx.db.select().from(builds).where(and(eq(builds.live, true), eq(builds.status, 'running'))).all();
      for (const b of live) await enqueueFor('stop', b.id);
      return { jobs: live.length };
    },
    'builds.changedModules': (p) => changedModulesPreview(ctx, p.branchId),
    'builds.launchJson': (p) => {
      const b = mustBuild(ctx, p.buildId);
      return { json: JSON.stringify({ version: '0.2.0', configurations: [launchConfig(ctx, p.buildId)] }, null, 2), debugPort: b.debugPort };
    },
    'builds.writeLaunchJson': (p) => writeLaunchJson(ctx, p.buildId),
    'builds.credentials': (p) => credentials(ctx, p.buildId),
    'builds.connectionString': (p) => {
      const b = mustBuild(ctx, p.buildId);
      const c = ctx.store.require(b.projectId).postgres;
      return { value: `postgresql://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${b.dbName}` };
    },
    'builds.resetAdminPassword': async (p) => {
      const b = mustBuild(ctx, p.buildId);
      const cfg = ctx.store.require(b.projectId);
      const pw = cfg.connect.adminPassword ?? 'admin';
      await pg.query(cfg.postgres, b.dbName, "UPDATE res_users SET password = $1 WHERE id = (SELECT res_id FROM ir_model_data WHERE module = 'base' AND name = 'user_admin')", [pw]);
      audit(ctx, { projectId: b.projectId, action: 'build.resetAdminPassword', target: `${b.composeProject}#${b.number}` });
      return { ok: true as const };
    },
    'builds.users': async (p) => {
      const b = mustBuild(ctx, p.buildId);
      return { items: await buildUsers(ctx.store.require(b.projectId), b) };
    },
    'builds.connectAs': (p) => {
      const b = mustBuild(ctx, p.buildId);
      if (!runtimeState.docker.ok) throw new BmError('DOCKER_DOWN', 'Docker Desktop не запущен: запустите его (кнопка «Запустить» вверху окна) и повторите');
      const br = branchRow(ctx, b.branchId);
      return connectAs(ctx, ctx.store.require(b.projectId), b, p.login, br ? codeDir(ctx, br) : null);
    },
    'builds.modulesAction': (p) => enqueueFor('modules', p.buildId, { install: p.install, update: p.update }),
    'builds.testsAction': (p) => {
      if (!mustBuild(ctx, p.buildId).live) throw new BmError('BAD_STATE', 'Тесты запускаются только на живой сборке');
      return enqueueFor('tests', p.buildId, { modules: p.modules });
    },
    'backups.list': (p) => listBackups(ctx.store.require(p.projectId)),
    'backups.import': async (p) => {
      const cfg = ctx.store.require(p.projectId);
      if (!fs.existsSync(p.path)) throw new BmError('NO_BACKUP', `Файл не найден: ${p.path}`);
      const prod = branchByName(ctx, cfg.id, cfg.production.branch);
      if (!prod) throw new BmError('NO_BRANCH', 'Ветка Production не найдена');
      return { jobId: await requestBuildChecked(ctx, prod.id, { trigger: 'import_backup', kind: 'new', backupPath: toPosix(p.path) }) };
    },
    'shell.open': (p) => shellOpen(ctx, p),
  });
}
