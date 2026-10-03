import fs from 'node:fs';
import os from 'node:os';
import { execa } from 'execa';
import { BmError, type AppStateView, type Lang, type SystemStatus } from '@bm/shared';
import type { Ctx } from '../context';
import { runtimeState } from '../state';
import { listeningPorts } from '../util/ports';
import { pgPing } from '../pg';
import { ensureManagedPostgres } from '../docker/postgres';
import { summaries } from './projects';
import { outdatedSkills } from './agents';
import { bus } from '../events';
import { audit } from './audit';
import { reconcile } from '../reconcile';
import * as git from '../git';
import { isMac } from '../util/platform';
import { t } from '../i18n';

let lastReconcile = 0;

export function appState(ctx: Ctx): AppStateView {
  return {
    firstRun: !ctx.store.appExists,
    app: ctx.store.app,
    configDir: ctx.configDir,
    dataDir: ctx.dataDir,
    proxyPort: ctx.proxyPort ?? ctx.store.app.proxyPort,
    version: ctx.appVersion,
  };
}

/** First-run wizard: writes app.yaml; the Traefik port is 80 if free, otherwise 8080 (spec 3). */
export async function completeFirstRun(ctx: Ctx, proxyPort?: number, language?: Lang): Promise<{ ok: true }> {
  let port = proxyPort;
  if (!port) {
    const busy = await listeningPorts();
    port = busy.has(80) ? 8080 : 80;
  }
  const next = ctx.store.updateApp((doc) => {
    doc.commentBefore = t('system.appYamlComment');
    // The language chosen in the wizard (D69); without it app.yaml keeps the default.
    if (language) doc.set('language', language);
    doc.set('proxyPort', port);
  });
  ctx.toMain({ kind: 'appConfig', config: next });
  audit(ctx, { action: 'app.firstRun', target: 'app.yaml', params: { proxyPort: port } });
  bus.emit({ type: 'system.changed' });
  return { ok: true };
}

export async function freeDiskGb(dir: string): Promise<number | null> {
  try {
    const s = await fs.promises.statfs(dir);
    return (s.bavail * s.bsize) / 1024 ** 3;
  } catch {
    return null;
  }
}

let ghCache: { ok: boolean; text: string } | null = null;
async function ghStatus(exe: string): Promise<{ ok: boolean; text: string }> {
  if (ghCache) return ghCache;
  const r = await execa(exe === 'auto' ? 'gh' : exe, ['--version'], { reject: false, windowsHide: true });
  ghCache =
    r.exitCode === 0
      ? { ok: true, text: String(r.stdout).split('\n')[0]! }
      : { ok: false, text: t('system.ghMissing') };
  return ghCache;
}

let gitCache: { ok: boolean; text: string } | null = null;
/** Git for Windows is required (fetch, worktrees, clone); cached once found — a missing git is re-checked. */
async function gitStatus(): Promise<{ ok: boolean; text: string }> {
  if (gitCache) return gitCache;
  const v = await git.version();
  const s = v ? { ok: true, text: v } : { ok: false, text: git.gitMissingText() };
  if (v) gitCache = s;
  return s;
}

const HEAL_PAUSE_MS = 5 * 60_000;
const lastHeal = new Map<string, number>();

export async function systemStatus(ctx: Ctx, refresh: boolean): Promise<SystemStatus> {
  if (refresh && runtimeState.docker.ok && Date.now() - lastReconcile > 5000) {
    lastReconcile = Date.now();
    await reconcile(ctx).catch(() => {});
  }
  if (refresh) {
    for (const p of ctx.store.list()) {
      if (!p.config) continue;
      try {
        const v = await pgPing(p.config.postgres);
        runtimeState.postgres.set(p.id, { ok: true, text: `${p.config.postgres.host}:${p.config.postgres.port}, PostgreSQL ${v}` });
      } catch (err) {
        runtimeState.postgres.set(p.id, { ok: false, text: (err as Error).message });
        // The app's own Postgres heals itself (container stopped, port unpublished or reserved by Windows, D62); the
        // result lands in runtimeState and a moved port reaches the UI through config.changed.
        // Status polls every 10 s: one attempt per project in HEAL_PAUSE_MS, so a failing heal does not recreate the
        // container over and over.
        const id = p.id;
        if (p.config.postgres.mode === 'managed' && p.config.enabled && Date.now() - (lastHeal.get(id) ?? 0) > HEAL_PAUSE_MS) {
          lastHeal.set(id, Date.now());
          void ensureManagedPostgres(ctx, p.config).then(
            () => bus.emit({ type: 'system.changed' }),
            (e) => runtimeState.postgres.set(id, { ok: false, text: (e as Error).message }),
          );
        }
      }
    }
  }
  const free = await freeDiskGb(ctx.dataDir);
  const limits = ctx.store.app.limits;
  return {
    docker: {
      ok: runtimeState.docker.ok,
      version: runtimeState.docker.version,
      text: runtimeState.docker.ok ? `Docker Engine ${runtimeState.docker.version}` : t('system.dockerDown', { error: runtimeState.docker.error ?? t('system.noAnswer') }),
    },
    traefik: {
      ok: runtimeState.traefik.ok,
      port: runtimeState.traefik.port,
      text: runtimeState.traefik.ok ? t('system.traefikRunning', { port: runtimeState.traefik.port }) : (runtimeState.traefik.error ?? t('system.traefikStopped')),
    },
    git: await gitStatus(),
    postgres: Object.fromEntries(runtimeState.postgres),
    gh: await ghStatus(ctx.store.app.desktop.gh),
    disk: { freeGb: free, path: ctx.dataDir, low: free !== null && free < limits.minFreeDiskGb },
    running: { count: runtimeState.runningBuilds, limit: limits.maxRunningBuilds },
    queue: { running: runtimeState.queue.running, queued: runtimeState.queue.queued, maxParallel: limits.maxParallelBuilds },
    fetches: summaries(ctx).map((s) => ({ projectId: s.id, at: s.lastFetchAt, error: s.lastFetchError })),
    discrepancies: runtimeState.discrepancies,
    orphans: runtimeState.orphans,
    outdatedSkills: outdatedSkills(ctx),
    paths: { configDir: ctx.configDir, dataDir: ctx.dataDir, logsDir: ctx.logsDir },
  };
}

export function dockerDesktopExe(ctx: Ctx): string {
  const c = ctx.store.app.desktop.dockerDesktopExe;
  if (c !== 'auto') return c;
  const candidates = isMac
    ? ['/Applications/Docker.app', `${os.homedir()}/Applications/Docker.app`]
    : [
        `${process.env.ProgramFiles ?? 'C:/Program Files'}/Docker/Docker/Docker Desktop.exe`,
        `${process.env.LOCALAPPDATA ?? ''}/Programs/Docker/Docker/Docker Desktop.exe`,
      ];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0]!;
}

export async function startDockerDesktop(ctx: Ctx): Promise<{ ok: true }> {
  const exe = dockerDesktopExe(ctx);
  if (!fs.existsSync(exe)) throw new BmError('NO_DOCKER_DESKTOP', t('system.noDockerDesktop', { exe }));
  // macOS: an .app bundle is started through LaunchServices (D67).
  const sub = isMac ? execa('open', [exe], { detached: true, stdio: 'ignore', reject: false }) : execa(exe, [], { detached: true, stdio: 'ignore', windowsHide: false, reject: false });
  sub.unref();
  void sub.catch(() => {});
  audit(ctx, { action: 'docker.start', target: exe });
  return { ok: true };
}
