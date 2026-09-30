import path from 'node:path';
import { eq } from 'drizzle-orm';
import { BmError } from '@bm/shared';
import type { Ctx } from './context';
import { jobs } from './db/schema';
import { detectProject } from './detect';
import * as git from './git';
import { configEffective, configGet, configPut, jsonSchemas, setBranchOverrides } from './services/config';
import { checkPostgres, createProject, getProject, setEnabled, summaries, updateProject } from './services/projects';
import { completeFirstRun, appState, systemStatus, startDockerDesktop } from './services/system';
import { jobLog, jobView, listJobs } from './services/jobs-view';
import { defaultCloneDir, loginProject, probeRepo, requestClone, saveToken } from './services/repo';
import { requestSetup } from './services/project-setup';
import { allocatePgPort } from './docker/postgres';
import {
  addBranch,
  addPreview,
  forkBranch,
  forkName,
  getBranchView,
  gitBranches,
  listBranches,
  mustBranch,
  previewBranch,
  resetToRule,
  setHidden,
  setStage,
} from './services/branches';
import { requestFetch } from './services/fetch';
import { ensureBranchWorktree } from './services/worktree-actions';
import { assertFolderUsable } from './git/worktrees';
import { listAudit } from './services/audit';
import { getQueue } from './jobs/queue';
import { registerBuildHandlers } from './services/build-actions';
import { registerAgentHandlers } from './services/agents';
import { snapshotHandlers } from './services/snapshots';
import { monitorView } from './services/monitor';
import { requestImageBuild } from './services/project-setup';
import { deletePreview, requestDelete } from './services/branch-delete';
import { mergeUrl } from './services/merge';
import { projectDeletePreview, requestProjectDelete } from './services/project-delete';
import { pgMigratePreview, requestPgMigrate } from './services/pg-migrate';
import { readLogs } from './services/logs';
import { cleanupOrphans } from './reconcile';

/** All RPC methods of Core. */
export function registerHandlers(ctx: Ctx): void {
  ctx.rpc.register({
    'system.ping': () => ({ pong: true, pid: process.pid, startedAt: ctx.startedAt }),
    'system.state': () => appState(ctx),
    'system.completeFirstRun': (p) => completeFirstRun(ctx, p.proxyPort),
    'system.status': (p) => systemStatus(ctx, !!p.refresh),
    'system.startDocker': () => startDockerDesktop(ctx),

    'projects.list': () => summaries(ctx),
    'projects.get': (p) => getProject(ctx, p.projectId),
    'projects.detect': async (p) =>
      detectProject({ mirror: p.mirror, url: p.url, folder: p.folder ?? null }, {
        worktreesFallback: path.join(ctx.dataDir, 'worktrees'),
        existingIds: ctx.store.list().map((e) => e.id),
        filestoreRoot: path.join(ctx.dataDir, 'filestore'),
        pgPort: await allocatePgPort(ctx),
        odoo: p.odoo,
      }),
    'projects.create': (p) => {
      const s = createProject(ctx, p.yaml);
      // «Odoo in Docker»: Postgres container and Odoo image are prepared right away (D30).
      requestSetup(ctx, s.id);
      // First fetch right away: branches are laid out by the rules without waiting for the timer (criterion 3).
      requestFetch(ctx, s.id);
      return s;
    },
    'projects.checkPostgres': (p) => checkPostgres(p.yaml),
    'projects.login': (p) => loginProject(ctx, p.projectId),

    'repo.probe': (p) => probeRepo(p.url),
    'repo.login': (p) => probeRepo(p.url, true),
    'repo.saveToken': (p) => saveToken(p.url, p.username, p.token),
    'repo.defaultDir': (p) => ({ dir: defaultCloneDir(ctx, p.url, p.suffix) }),
    'repo.clone': (p) => requestClone(ctx, p),
    'repo.folderRemote': (p) => git.folderRemoteUrl(p.path),
    'projects.update': (p) => updateProject(ctx, p.projectId, p.yaml),
    'projects.setEnabled': (p) => setEnabled(ctx, p.projectId, p.enabled),
    'projects.deletePreview': (p) => projectDeletePreview(ctx, p.projectId),
    'projects.delete': (p) => requestProjectDelete(ctx, p.projectId, p.confirm),
    'projects.pgMigratePreview': (p) => pgMigratePreview(ctx, p.projectId),
    'projects.pgMigrate': (p) => requestPgMigrate(ctx, p.projectId),

    'config.get': (p) => configGet(ctx, p),
    'config.put': (p) => configPut(ctx, p),
    'config.effective': (p) => configEffective(ctx, p.branchId),
    'config.jsonSchema': () => jsonSchemas(),
    'config.app': () => ctx.store.app,

    'branches.list': (p) => listBranches(ctx, p.projectId),
    'branches.get': (p) => getBranchView(ctx, p.branchId),
    'branches.gitList': async (p) => gitBranches(ctx, ctx.store.require(p.projectId)),
    'branches.add': (p) => addBranch(ctx, p),
    'branches.addPreview': (p) => addPreview(ctx, p),
    'branches.setStage': (p) => setStage(ctx, p.branchId, p.stage),
    'branches.resetToRule': (p) => resetToRule(ctx, p.branchId),
    'branches.setHidden': (p) => setHidden(ctx, p.branchId, p.hidden),
    'branches.setOverrides': async (p) => {
      if (p.overrides.folder) await assertFolderUsable(p.overrides.folder);
      setBranchOverrides(ctx, p.branchId, p.overrides);
      return getBranchView(ctx, p.branchId);
    },
    'branches.fork': (p) => forkBranch(ctx, p),
    'branches.forkName': (p) => forkName(ctx, p.projectId, p.name),
    'branches.preview': (p) => previewBranch(ctx, p.projectId, p.branch),
    'branches.ensureWorktree': (p) => {
      mustBranch(ctx, p.branchId);
      return ensureBranchWorktree(ctx, p.branchId);
    },

    'branches.deletePreview': (p) => deletePreview(ctx, p.branchId),
    'branches.delete': (p) => requestDelete(ctx, p),
    'branches.merge': (p) => mergeUrl(ctx, p.sourceId, p.targetId),

    'git.fetch': (p) => ({ jobs: requestFetch(ctx, p.projectId) }),

    'jobs.list': (p) => listJobs(ctx, p),
    'jobs.get': (p) => {
      const r = ctx.db.select().from(jobs).where(eq(jobs.id, p.jobId)).get();
      if (!r) throw new BmError('NO_JOB', 'Задача не найдена');
      return jobView(r);
    },
    'jobs.cancel': (p) => {
      getQueue().cancel(p.jobId);
      return { ok: true as const };
    },
    'jobs.log': (p) => jobLog(ctx, p.jobId, p.tail),
    'audit.list': (p) => listAudit(ctx, p),
    'logs.read': (p) => readLogs(ctx, p),
    'system.cleanupOrphans': (p) => cleanupOrphans(ctx, p.items),
  });
  registerBuildHandlers(ctx);
  registerAgentHandlers(ctx);
  ctx.rpc.register(snapshotHandlers(ctx));
  ctx.rpc.register({
    'monitor.get': (p) => monitorView(ctx, p.buildId),
    'projects.buildImage': (p) => requestImageBuild(ctx, p.projectId),
  });
}
