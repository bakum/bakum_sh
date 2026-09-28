// Development sandbox project (prompt rule 5): DB prefix o19_bmdev_, hosts {slug}.dev.localhost, its own clone of
// demz-odoo with a local bare "origin" (tmp/sandbox), worktrees and filestore under tmp/sandbox.
// Runtime values (image, network, mounts, Postgres) come from detecting the real repo; nothing there is modified.
import YAML from 'yaml';
import { bm } from './pw.mjs';

export const SANDBOX = 'E:/bakum_sh/tmp/sandbox';

export async function ensureSandbox(win, { id = 'bmdev' } = {}) {
  const state = await bm(win, 'system.state');
  if (state.firstRun) await bm(win, 'system.completeFirstRun', {});
  const list = await bm(win, 'projects.list');
  if (list.some((p) => p.id === id)) return id;
  const d = await bm(win, 'projects.detect', { path: 'E:/demz-odoo-19/repositories/demz-odoo' });
  const cfg = structuredClone(d.proposals.demz);
  cfg.id = id;
  cfg.name = 'Sandbox (demz-odoo)';
  cfg.repo.path = `${SANDBOX}/demz-odoo`;
  cfg.repo.github = null;
  cfg.repo.issueUrl = null;
  cfg.repo.worktreesDir = `${SANDBOX}/worktrees`;
  cfg.repo.fetchIntervalMin = 0;
  cfg.naming.db = 'o19_bmdev_{slug_}_{build}';
  cfg.naming.host = '{slug}.dev.localhost';
  cfg.runtime.filestore.hostDir = `${SANDBOX}/filestore`;
  cfg.runtime.debug.pathMappings = [{ local: '{worktree}', remote: cfg.runtime.repoMount }];
  await bm(win, 'projects.create', { yaml: YAML.stringify(cfg) });
  return id;
}

export async function waitJobs(win, projectId, timeoutMs = 3600000, onTick) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const active = await bm(win, 'jobs.list', { projectId, active: true });
    if (!active.length) return;
    if (onTick) await onTick(active);
    if (Date.now() > until) throw new Error('jobs timeout: ' + JSON.stringify(active));
    await new Promise((r) => setTimeout(r, 3000));
  }
}

export async function branch(win, projectId, name) {
  const l = await bm(win, 'branches.list', { projectId });
  return [...l.production, ...l.staging, ...l.development].find((b) => b.name === name);
}

export async function lastBuild(win, branchId) {
  return (await bm(win, 'builds.list', { branchId, limit: 1 })).items[0];
}
