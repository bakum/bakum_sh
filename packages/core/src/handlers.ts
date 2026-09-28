import path from 'node:path';
import { eq } from 'drizzle-orm';
import { BmError } from '@bm/shared';
import type { Ctx } from './context';
import { jobs } from './db/schema';
import { detectProject } from './detect';
import { configEffective, configGet, configPut, jsonSchemas, setBranchOverrides } from './services/config';
import { createProject, getProject, setEnabled, summaries, updateProject } from './services/projects';
import { completeFirstRun, appState, systemStatus, startDockerDesktop } from './services/system';
import { jobView, listJobs } from './services/jobs-view';
import {
  addBranch,
  forkBranch,
  forkName,
  getBranchView,
  gitBranches,
  listBranches,
  mustBranch,
  previewBranch,
  resetToRule,
  setStage,
} from './services/branches';
import { requestFetch } from './services/fetch';
import { ensureBranchWorktree } from './services/worktree-actions';
import { listAudit } from './services/audit';
import { getQueue } from './jobs/queue';
import { registerBuildHandlers } from './services/build-actions';
import { deletePreview, requestDelete } from './services/branch-delete';
import { mergeUrl } from './services/merge';

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
    'projects.detect': (p) =>
      detectProject(p.path, {
        worktreesFallback: path.join(ctx.dataDir, 'worktrees'),
        existingIds: ctx.store.list().map((e) => e.id),
      }),
    'projects.create': (p) => createProject(ctx, p.yaml),
    'projects.update': (p) => updateProject(ctx, p.projectId, p.yaml),
    'projects.setEnabled': (p) => setEnabled(ctx, p.projectId, p.enabled),

    'config.get': (p) => configGet(ctx, p),
    'config.put': (p) => configPut(ctx, p),
    'config.effective': (p) => configEffective(ctx, p.branchId),
    'config.jsonSchema': () => jsonSchemas(),
    'config.app': () => ctx.store.app,

    'branches.list': (p) => listBranches(ctx, p.projectId),
    'branches.get': (p) => getBranchView(ctx, p.branchId),
    'branches.gitList': async (p) => gitBranches(ctx, ctx.store.require(p.projectId)),
    'branches.add': (p) => addBranch(ctx, p),
    'branches.setStage': (p) => setStage(ctx, p.branchId, p.stage),
    'branches.resetToRule': (p) => resetToRule(ctx, p.branchId),
    'branches.setOverrides': (p) => {
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
    'audit.list': (p) => listAudit(ctx, p.projectId, p.limit),
  });
  registerBuildHandlers(ctx);
}
