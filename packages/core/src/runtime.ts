import type { Ctx } from './context';
import { dockerAlive } from './docker/client';
import { runtimeState } from './state';
import { bus } from './events';
import { log } from './util/logger';
import { nowIso } from './util/time';

type Hook = (ctx: Ctx) => void | Promise<void>;
const onDockerUp: Hook[] = [];
const onStart: Hook[] = [];
const onStop: ((ctx: Ctx, cancel: boolean) => Promise<void>)[] = [];
const hookHandlers = new Map<string, (ctx: Ctx, args: string[]) => Promise<void>>();

/** Background services register here (fetch scheduler, queue, watchers, reconcile). */
export const runtime = {
  onDockerUp: (h: Hook) => onDockerUp.push(h),
  onStart: (h: Hook) => onStart.push(h),
  onStop: (h: (ctx: Ctx, cancel: boolean) => Promise<void>) => onStop.push(h),
  onHook: (name: string, h: (ctx: Ctx, args: string[]) => Promise<void>) => hookHandlers.set(name, h),
};

let dockerTimer: NodeJS.Timeout | null = null;

async function pollDocker(ctx: Ctx): Promise<void> {
  const r = await dockerAlive();
  const was = runtimeState.docker.ok;
  runtimeState.docker = { ok: r.ok, version: r.version, error: r.error, checkedAt: nowIso() };
  if (r.ok !== was) {
    log().info({ ok: r.ok }, 'docker state changed');
    bus.emit({ type: 'system.changed' });
    if (r.ok) {
      for (const h of onDockerUp) {
        try {
          await h(ctx);
        } catch (err) {
          log().error({ err }, 'docker-up hook failed');
        }
      }
    }
  }
}

export async function startRuntime(ctx: Ctx): Promise<void> {
  for (const h of onStart) {
    try {
      await h(ctx);
    } catch (err) {
      log().error({ err }, 'start hook failed');
    }
  }
  await pollDocker(ctx);
  const loop = async (): Promise<void> => {
    await pollDocker(ctx).catch(() => {});
    dockerTimer = setTimeout(() => void loop(), runtimeState.docker.ok ? 10_000 : 3_000);
  };
  dockerTimer = setTimeout(() => void loop(), 3_000);
}

export async function stopRuntime(ctx: Ctx, cancel: boolean): Promise<void> {
  if (dockerTimer) clearTimeout(dockerTimer);
  for (const h of onStop) await h(ctx, cancel).catch((err) => log().error({ err }, 'stop hook failed'));
  ctx.store.close();
}

/** `--hook <name> [args]` from a second process instance (git hooks, future CLI). */
export async function handleHook(ctx: Ctx, argv: string[]): Promise<void> {
  const [name, ...args] = argv;
  const h = name ? hookHandlers.get(name) : undefined;
  log().info({ name, args }, 'hook received');
  if (h) await h(ctx, args).catch((err) => log().error({ err }, 'hook failed'));
}
