import fs from 'node:fs';
import path from 'node:path';
import { and, desc, eq, inArray, max } from 'drizzle-orm';
import { BmError, BUILD_STEPS, type BuildKind, type BuildTrigger, type BuildStep, type ProjectConfig, type Stage } from '@bm/shared';
import type { Ctx } from '../context';
import { buildLogsDir } from '../context';
import { builds, type BranchRow } from '../db/schema';
import { resolveBranchScope } from '../config/effective';
import { assertHost, assertSqlIdent, parseBranchName, renderTemplate, slugUnderscore } from '../config/templates';
import { branchRow } from '../services/branch-rows';
import { configHash, liveBuild } from './view';
import { assertFolderUsable } from '../git/worktrees';
import { assertNotLegacy } from '../config/legacy';
import { getQueue } from '../jobs/queue';
import { bus } from '../events';
import { runtimeState } from '../state';
import { audit } from '../services/audit';
import { nowIso } from '../util/time';
import { pickBackup } from './backups';

export interface BuildRequest {
  trigger: BuildTrigger;
  kind?: BuildKind;
  backupPath?: string;
  targetSha?: string;
}

/**
 * Validates a build request and creates the queued Build + Job (spec 8.3). Every check that could make the build
 * impossible runs here, before any resource exists (criterion 12).
 */
export async function requestBuildChecked(ctx: Ctx, branchId: number, req: BuildRequest): Promise<number> {
  const b = branchRow(ctx, branchId);
  if (!b) throw new BmError('NO_BRANCH', 'Ветка не найдена');
  const cfg = ctx.store.require(b.projectId);
  const scope = resolveBranchScope(cfg, b.name, b.stage, b.overrides).scope;
  if (scope.folder) await assertFolderUsable(scope.folder);
  return requestBuild(ctx, branchId, req);
}

/**
 * Whether the database comes from a production backup (D32): an explicit backup import always does; `database: backup`
 * does only when a backups folder is configured — without one Production gets a fresh database instead of failing.
 */
export function productionFromBackup(cfg: ProjectConfig, stage: Stage, database: string, backupPath?: string): boolean {
  if (backupPath) return true;
  if (database !== 'backup') return false;
  return stage !== 'production' || !!cfg.production.backups.dir;
}

/** Synchronous part: creates the Build row and enqueues its job. */
export function requestBuild(ctx: Ctx, branchId: number, req: BuildRequest): number {
  const b = branchRow(ctx, branchId);
  if (!b) throw new BmError('NO_BRANCH', 'Ветка не найдена');
  const cfg = ctx.store.require(b.projectId);
  assertNotLegacy(cfg);
  const active = ctx.db
    .select()
    .from(builds)
    .where(and(eq(builds.branchId, branchId), inArray(builds.status, ['queued', 'building'])))
    .get();
  if (active) throw new BmError('BUILD_ACTIVE', `У ветки «${b.name}» уже идёт сборка #${active.number}. Дождитесь её или отмените.`);

  const scope = resolveBranchScope(cfg, b.name, b.stage, b.overrides).scope;
  const live = liveBuild(ctx, branchId);
  let kind: BuildKind = req.kind ?? 'new';
  if (kind === 'update' && !live) kind = 'new';

  const limits = ctx.store.app.limits;
  if (kind === 'new' && !live && runtimeState.runningBuilds >= limits.maxRunningBuilds) {
    const text = `Живых сборок уже ${runtimeState.runningBuilds} при лимите ${limits.maxRunningBuilds} (maxRunningBuilds).`;
    if (limits.enforce) throw new BmError('LIMIT', `${text} Остановите или отбросьте ненужные сборки.`);
    ctx.toMain({ kind: 'notify', notifType: 'limit', title: 'Лимит живых сборок', body: text });
  }

  const n = (ctx.db.select({ m: max(builds.number) }).from(builds).where(eq(builds.branchId, branchId)).get()?.m ?? 0) + 1;
  const slug_ = slugUnderscore(b.slug);
  const parsed = parseBranchName(b.name, cfg.naming.parse);
  const vars = { project: cfg.id, branch: b.name, slug: b.slug, slug_, build: n, stage: b.stage, ...parsed };
  const host = assertHost(renderTemplate(cfg.naming.host, vars));
  const composeProject = renderTemplate(cfg.naming.composeProject, vars);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(composeProject)) throw new BmError('BAD_NAME', `Недопустимое имя compose-проекта «${composeProject}»`);

  let dbName: string;
  let dbSource: string;
  if (kind === 'update') {
    dbName = live!.dbName;
    dbSource = `update:#${live!.number}`;
  } else {
    dbName = assertSqlIdent(renderTemplate(cfg.naming.db, vars));
    if (b.stage === 'production' && scope.database.startsWith('copy:')) {
      throw new BmError('BAD_CONFIG', 'Production не может копировать БД другой ветки: укажите database: backup или fresh');
    }
    if (productionFromBackup(cfg, b.stage, scope.database, req.backupPath)) {
      if (b.stage !== 'production') throw new BmError('BAD_CONFIG', 'database: backup допустима только для Production');
      const file = req.backupPath ?? pickBackup(cfg)?.path;
      if (!file) {
        throw new BmError(
          'NO_BACKUP',
          `Не найден бэкап прода: папка ${cfg.production.backups.dir ?? '(не задана)'}, шаблон ${cfg.production.backups.pattern}. Положите файл .zip в папку или выберите его во вкладке Backups.`,
        );
      }
      if (!/\.(zip|dump)$/i.test(file)) {
        throw new BmError('BAD_BACKUP', `Файл ${path.basename(file)} не подходит: нужен бэкап Odoo (.zip) или дамп pg_dump -Fc с расширением .dump.`);
      }
      if (!fs.existsSync(file)) throw new BmError('NO_BACKUP', `Файл бэкапа не найден: ${file}`);
      dbSource = `backup:${path.basename(file)}`;
    } else {
      // database: backup without a backups folder → fresh (productionFromBackup).
      dbSource = scope.database === 'fresh' || scope.database === 'backup' ? 'fresh' : scope.database;
    }
  }

  const port = ctx.proxyPort ?? ctx.store.app.proxyPort;
  const steps: BuildStep[] = BUILD_STEPS.map((name) => ({ name, status: 'pending', startedAt: null, finishedAt: null }));
  const logDir = buildLogsDir(ctx, cfg.id);
  fs.mkdirSync(logDir, { recursive: true });
  const row = ctx.db
    .insert(builds)
    .values({
      branchId,
      projectId: cfg.id,
      number: n,
      stage: b.stage,
      trigger: req.trigger,
      kind,
      dbSource,
      dbName,
      host,
      composeProject,
      status: 'queued',
      steps,
      logPath: path.join(logDir, `${b.slug}-${n}.log`),
      configHash: configHash(cfg, scope, port),
      previousBuildId: live?.id ?? null,
      createdAt: nowIso(),
    })
    .returning()
    .get();
  const jobType = req.trigger === 'import_backup' ? 'import_backup' : 'build';
  const jobId = getQueue().enqueue(jobType, { projectId: cfg.id, branchId, buildId: row.id }, {
    branch: b.name,
    number: n,
    kind,
    trigger: req.trigger,
    backupPath: req.backupPath ?? null,
    targetSha: req.targetSha ?? null,
  });
  audit(ctx, { projectId: cfg.id, action: `build.${req.trigger}`, target: `${b.name}#${n}`, params: { kind, dbSource } });
  bus.emit({ type: 'build.changed', projectId: cfg.id, branchId, buildId: row.id });
  return jobId;
}

export function latestBuilds(ctx: Ctx, b: BranchRow, limit = 1) {
  return ctx.db.select().from(builds).where(eq(builds.branchId, b.id)).orderBy(desc(builds.number)).limit(limit).all();
}
