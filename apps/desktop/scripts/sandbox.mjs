// Creates the development sandbox project (spec rule 5): DB prefix o19_bmdev_, hosts {slug}.dev.localhost,
// filestore outside E:\demz-odoo-19. Used by the check-mN scenarios; never touches the real DEMZ preset.
import path from 'node:path';
import YAML from 'yaml';
import { bm } from './pw.mjs';

export async function ensureSandbox(win, { id = 'bmdev', repo = 'E:/demz-odoo-19/repositories/demz-odoo' } = {}) {
  const state = await bm(win, 'system.state');
  if (state.firstRun) await bm(win, 'system.completeFirstRun', {});
  const list = await bm(win, 'projects.list');
  if (list.some((p) => p.id === id)) return id;
  const d = await bm(win, 'projects.detect', { path: repo });
  const cfg = structuredClone(d.proposals.demz);
  cfg.id = id;
  cfg.name = 'Sandbox (demz-odoo)';
  cfg.naming.db = 'o19_bmdev_{slug_}_{build}';
  cfg.naming.host = '{slug}.dev.localhost';
  cfg.runtime.filestore.hostDir = path.join(state.dataDir, 'sandbox-filestore').replace(/\\/g, '/');
  cfg.repo.fetchIntervalMin = 0;
  await bm(win, 'projects.create', { yaml: YAML.stringify(cfg) });
  return id;
}

export async function waitJobs(win, projectId, timeoutMs = 600000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const active = await bm(win, 'jobs.list', { projectId, active: true });
    if (!active.length) return;
    if (Date.now() > until) throw new Error('jobs timeout: ' + JSON.stringify(active));
    await new Promise((r) => setTimeout(r, 1000));
  }
}
