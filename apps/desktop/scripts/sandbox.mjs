// Development sandbox project (prompt rule 5): DB prefix o19_bmdev_, hosts {slug}.dev.localhost. Its "GitHub" is the
// local bare repository tmp/sandbox/origin.git (D33: the app keeps its own mirror of it); tmp/sandbox/demz-odoo is the
// user's clone. Runtime values (image, network, mounts, Postgres) come from detecting the real repo; nothing there is
// modified.
import YAML from 'yaml';
import { bm } from './pw.mjs';

export const SANDBOX = 'E:/bakum_sh/tmp/sandbox';
export const ORIGIN_URL = `file:///${SANDBOX}/origin.git`;

export async function waitJob(win, jobId, timeoutMs = 1800000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const j = await bm(win, 'jobs.get', { jobId });
    if (['success', 'failed', 'cancelled', 'interrupted'].includes(j.status)) return j;
    if (Date.now() > until) throw new Error('job timeout: ' + JSON.stringify(j));
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/**
 * Sandbox project from the DEMZ preset; `stages` overrides stage settings (e.g. fresh Development databases).
 * `postgres`: 'external' — the Postgres of E:/demz-odoo-19 (odoo19-db) as before; 'managed' — the app's own
 * bm-<id>-db in the network bm-<id> (what the wizard proposes for new projects). `preset`: the wizard proposal to start
 * from (`demz`, `generic`).
 */
export async function ensureSandbox(win, { id = 'bmdev', stages = null, mirror = null, postgres = 'external', preset = 'demz' } = {}) {
  const state = await bm(win, 'system.state');
  if (state.firstRun) await bm(win, 'system.completeFirstRun', {});
  const list = await bm(win, 'projects.list');
  if (list.some((p) => p.id === id)) return id;
  let dir = mirror;
  if (!dir) {
    const r = await bm(win, 'repo.clone', { url: ORIGIN_URL, mirror: true, shallow: false });
    const j = await waitJob(win, r.jobId);
    if (j.status !== 'success') throw new Error('mirror: ' + j.error);
    dir = r.dir;
  }
  const d = await bm(win, 'projects.detect', { mirror: dir, url: ORIGIN_URL, folder: 'E:/demz-odoo-19/repositories/demz-odoo' });
  const cfg = structuredClone(d.proposals[preset]);
  if (postgres === 'managed') {
    cfg.runtime.network = `bm-${id}`;
    cfg.postgres.protectedContainers = cfg.postgres.protectedContainers.map((c) => (c === `bm-${cfg.id}-db` ? `bm-${id}-db` : c));
  } else if (d.postgres) {
    cfg.runtime.network = d.network;
    cfg.postgres = { ...cfg.postgres, mode: 'external', host: d.postgres.host, port: d.postgres.port };
    cfg.postgres.protectedContainers = cfg.postgres.protectedContainers.filter((c) => c !== `bm-${cfg.id}-db`);
  }
  cfg.id = id;
  cfg.name = 'Sandbox (demz-odoo)';
  cfg.repo.localFolder = `${SANDBOX}/demz-odoo`;
  cfg.repo.github = null;
  cfg.repo.issueUrl = null;
  cfg.repo.worktreesDir = `${SANDBOX}/worktrees`;
  cfg.repo.fetchIntervalMin = 0;
  cfg.naming.db = 'o19_bmdev_{slug_}_{build}';
  cfg.naming.host = '{slug}.dev.localhost';
  cfg.runtime.filestore.hostDir = `${SANDBOX}/filestore`;
  cfg.runtime.debug.pathMappings = [{ local: '{worktree}', remote: cfg.runtime.repoMount }];
  if (stages) for (const [k, v] of Object.entries(stages)) cfg.stages[k] = { ...cfg.stages[k], ...v };
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
  return [...l.production, ...l.development].find((b) => b.name === name);
}

export async function lastBuild(win, branchId) {
  return (await bm(win, 'builds.list', { branchId, limit: 1 })).items[0];
}
