import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { BmError, type ProjectConfig } from '@bm/shared';
import type { Ctx } from '../context';
import { branches, jobs, type BranchRow } from '../db/schema';
import { resolveBranchScope } from '../config/effective';
import { branchProtected, buildUrl } from '../docker/compose';
import { liveBuild } from '../builds/view';
import { getQueue } from '../jobs/queue';
import { runtimeState } from '../state';
import { assertBranchFolder } from '../git/worktrees';
import { isInside, samePath, toPosix } from '../util/paths';

/**
 * Commands of the app's command line `bm` (D53). Only what an assistant may do on its own: read the state, update
 * modules, run tests and restart a Development build. Everything runs as a job of the queue (History, Audit Logs), the
 * caller waits for it and gets its log. Production and protected builds are refused.
 */
export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface CliRequest {
  argv: string[];
  cwd: string;
}

export const CLI_HELP = [
  'Odoo Branch Manager — командная строка (приложение должно быть запущено)',
  '',
  '  bm status [ветка] [--json]            ветки проекта и их живые сборки',
  '  bm modules <ветка> -u a,b [-i c]      обновить / установить модули (контейнер на время останавливается)',
  '  bm test <ветка> <модуль> [модуль…]    тесты на временной копии базы, итог — в бейдж Test сборки',
  '  bm restart <ветка>                    перезапустить контейнер сборки',
  '',
  'Общие параметры:',
  '  -p, --project <id>   проект; по умолчанию — по текущей папке (клон, worktree, папка skill) или единственный',
  '',
  'Ветка — имя (19.0-demz-crm) или slug (crm). Production и защищённые ветки CLI не меняет — только приложение.',
  'Код выхода: 0 — задача выполнена, 1 — ошибка или упавшие тесты, 2 — приложение не запущено.',
];

interface Parsed {
  cmd: string | null;
  args: string[];
  project: string | null;
  json: boolean;
  install: string[];
  update: string[];
}

const MODULE_RE = /^[a-z0-9_]+$/;
const list = (v: string): string[] => v.split(',').map((s) => s.trim()).filter(Boolean);

export function parseArgs(argv: string[]): Parsed {
  const p: Parsed = { cmd: null, args: [], project: null, json: false, install: [], update: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new BmError('CLI_ARGS', `После ${a} нужно значение`);
      return v;
    };
    if (a === '-p' || a === '--project') p.project = next();
    else if (a === '--json') p.json = true;
    else if (a === '-u' || a === '--update') p.update.push(...list(next()));
    else if (a === '-i' || a === '--install') p.install.push(...list(next()));
    else if (a === '-h' || a === '--help') p.cmd = 'help';
    else if (a.startsWith('-')) throw new BmError('CLI_ARGS', `Неизвестный параметр ${a}. Справка: bm help`);
    else if (!p.cmd) p.cmd = a;
    else p.args.push(...list(a));
  }
  for (const m of [...p.install, ...p.update, ...(p.cmd === 'test' ? p.args.slice(1) : [])]) {
    if (!MODULE_RE.test(m)) throw new BmError('CLI_ARGS', `«${m}» — не имя модуля (a-z, 0-9, _)`);
  }
  return p;
}

/** Folders that belong to a project, for choosing it by the current folder. */
function projectDirs(ctx: Ctx, cfg: ProjectConfig): string[] {
  const wt = cfg.repo.worktreesDir.replace(/[\\/]+$/, '');
  const root = path.dirname(wt);
  const out = [cfg.repo.localFolder, cfg.agents.skillsDir, wt];
  if (path.basename(wt).toLowerCase() === 'worktrees' && !samePath(root, ctx.dataDir) && !isInside(ctx.dataDir, root)) out.push(root);
  return out.filter((d): d is string => !!d);
}

export function resolveProject(ctx: Ctx, explicit: string | null, cwd: string): ProjectConfig {
  const all = ctx.store.list().filter((e) => e.config).map((e) => e.config!);
  if (explicit) return ctx.store.require(explicit);
  let best: { cfg: ProjectConfig; len: number } | null = null;
  for (const cfg of all) {
    for (const d of projectDirs(ctx, cfg)) {
      if ((samePath(d, cwd) || isInside(d, cwd)) && (!best || d.length > best.len)) best = { cfg, len: d.length };
    }
  }
  if (best) return best.cfg;
  if (all.length === 1) return all[0]!;
  throw new BmError('CLI_PROJECT', `Не понял, какой проект: запустите bm из папки проекта или укажите -p <id> (${all.map((c) => c.id).join(', ') || 'проектов нет'}).`);
}

function resolveBranch(ctx: Ctx, cfg: ProjectConfig, ref: string | undefined): BranchRow {
  if (!ref) throw new BmError('CLI_ARGS', 'Укажите ветку: имя или slug. Список — bm status');
  const rows = ctx.db.select().from(branches).where(eq(branches.projectId, cfg.id)).all();
  const b = rows.find((r) => r.name === ref || r.slug === ref);
  if (!b) throw new BmError('CLI_BRANCH', `Ветки «${ref}» нет в проекте ${cfg.id}. Список — bm status`);
  return b;
}

const isProtected = (cfg: ProjectConfig, b: BranchRow): boolean =>
  branchProtected(cfg, b.name, b.stage, resolveBranchScope(cfg, b.name, b.stage, b.overrides).scope);

function status(ctx: Ctx, cfg: ProjectConfig, ref: string | undefined, json: boolean, io: CliIo): number {
  const rows = ctx.db
    .select()
    .from(branches)
    .where(eq(branches.projectId, cfg.id))
    .all()
    .filter((b) => (ref ? b.name === ref || b.slug === ref : !b.hidden));
  if (ref && !rows.length) throw new BmError('CLI_BRANCH', `Ветки «${ref}» нет в проекте ${cfg.id}`);
  const port = ctx.proxyPort ?? ctx.store.app.proxyPort;
  const items = rows
    .sort((a, b) => (a.stage === b.stage ? a.name.localeCompare(b.name) : a.stage === 'production' ? -1 : 1))
    .map((b) => {
      const live = liveBuild(ctx, b.id);
      const t = live?.tests;
      return {
        branch: b.name,
        slug: b.slug,
        stage: b.stage,
        protected: isProtected(cfg, b),
        build: live ? live.number : null,
        status: live?.status ?? 'нет сборки',
        db: live?.dbName ?? null,
        url: live ? buildUrl(live.host, port) : null,
        tests: t ? { passed: t.passed, failed: t.failed, errors: t.errors } : null,
      };
    });
  if (json) {
    io.out(JSON.stringify({ project: cfg.id, branches: items }, null, 2));
    return 0;
  }
  io.out(`Проект ${cfg.id} (${cfg.name})`);
  const table = items.map((x) => [
    x.slug,
    x.branch,
    x.stage + (x.protected ? ' protected' : ''),
    x.build ? `#${x.build} ${x.status}` : x.status,
    x.tests ? `tests ${x.tests.passed}/${x.tests.failed}/${x.tests.errors}` : '',
    x.url ?? '',
    x.db ?? '',
  ]);
  const widths = table.reduce<number[]>((w, r) => r.map((c, i) => Math.max(w[i] ?? 0, c.length)), []);
  for (const r of table) io.out(r.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd());
  return 0;
}

/** Enqueues a job for the live build of a Development branch and waits for it, printing its log. */
async function runJob(ctx: Ctx, cfg: ProjectConfig, ref: string | undefined, type: 'modules' | 'tests' | 'restart', params: Record<string, unknown>, io: CliIo): Promise<number> {
  const br = resolveBranch(ctx, cfg, ref);
  if (isProtected(cfg, br)) {
    throw new BmError('CLI_PROTECTED', `${br.name} — Production или защищённая ветка: CLI её не меняет. Это делает пользователь в приложении.`);
  }
  const live = liveBuild(ctx, br.id);
  if (!live) throw new BmError('CLI_NO_BUILD', `У ветки ${br.name} нет живой сборки: соберите её в приложении (Rebuild).`);
  await assertBranchFolder(ctx, br.id);
  const jobId = getQueue().enqueue(type, { projectId: cfg.id, branchId: br.id, buildId: live.id }, { number: live.number, ...params, source: 'cli' });
  io.out(`Задача #${jobId} (${type}) для ${br.name}, сборка #${live.number}`);
  return waitJob(ctx, jobId, io);
}

const TERMINAL = new Set(['success', 'failed', 'cancelled', 'interrupted']);

/** Follows the job log file until the job ends; the timestamp prefix of each line is dropped. */
async function waitJob(ctx: Ctx, jobId: number, io: CliIo): Promise<number> {
  let offset = 0;
  let rest = '';
  let toldDocker = false;
  const flush = (file: string): void => {
    if (!fs.existsSync(file)) return;
    const size = fs.statSync(file).size;
    if (size <= offset) return;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    offset = size;
    const lines = (rest + buf.toString('utf8')).split('\n');
    rest = lines.pop() ?? '';
    for (const l of lines) io.out(l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /, ''));
  };
  for (;;) {
    const j = ctx.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    if (!j) throw new BmError('NO_JOB', `Задача #${jobId} пропала`);
    const file = path.join(ctx.logsDir, 'jobs', `${j.id}-${j.type}.log`);
    flush(file);
    // D63: the job waits in the queue until Docker is up.
    if (j.status === 'queued' && !runtimeState.docker.ok && !toldDocker) {
      toldDocker = true;
      io.out('Docker Desktop не запущен: задача ждёт в очереди и начнётся, когда он запустится.');
    }
    if (TERMINAL.has(j.status)) {
      flush(file);
      if (rest) io.out(rest);
      if (j.status === 'success') {
        io.out(`Готово: задача #${jobId}`);
        return 0;
      }
      io.err(`Задача #${jobId}: ${j.status}${j.error ? ` — ${j.error}` : ''}`);
      return 1;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
}

export async function runCli(ctx: Ctx, req: CliRequest, io: CliIo): Promise<number> {
  try {
    const p = parseArgs(req.argv);
    if (!p.cmd || p.cmd === 'help') {
      for (const l of CLI_HELP) io.out(l);
      return 0;
    }
    if (p.cmd === 'version') {
      io.out(`Odoo Branch Manager ${ctx.appVersion}`);
      return 0;
    }
    const cfg = resolveProject(ctx, p.project, req.cwd);
    const [ref, ...mods] = p.args;
    switch (p.cmd) {
      case 'status':
        return status(ctx, cfg, ref, p.json, io);
      case 'modules':
        if (!p.install.length && !p.update.length) throw new BmError('CLI_ARGS', 'Укажите модули: -u a,b и/или -i c');
        return await runJob(ctx, cfg, ref, 'modules', { install: p.install, update: p.update }, io);
      case 'test':
        if (!mods.length) throw new BmError('CLI_ARGS', 'Укажите модули для тестов: bm test <ветка> <модуль> [модуль…]');
        return await runJob(ctx, cfg, ref, 'tests', { modules: mods }, io);
      case 'restart':
        return await runJob(ctx, cfg, ref, 'restart', {}, io);
      default:
        throw new BmError('CLI_ARGS', `Неизвестная команда «${p.cmd}». Справка: bm help`);
    }
  } catch (err) {
    io.err((err as Error).message);
    return 1;
  }
}

export const cliCommandPaths = (binDir: string): { cmd: string; sh: string } => ({
  cmd: toPosix(path.join(binDir, 'bm.cmd')),
  sh: toPosix(path.join(binDir, 'bm')),
});
