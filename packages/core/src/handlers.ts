import type { Ctx } from './context';
import { detectProject } from './detect';
import { configEffective, configGet, configPut, jsonSchemas } from './services/config';
import { createProject, getProject, setEnabled, summaries, updateProject } from './services/projects';
import { completeFirstRun, appState, systemStatus, startDockerDesktop } from './services/system';
import path from 'node:path';
import { listJobs } from './services/jobs-view';

/** All RPC methods of Core. Later milestones add their groups via registerXxx(ctx). */
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
    'jobs.list': (p) => listJobs(ctx, p),
  });
}
