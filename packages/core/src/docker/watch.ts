import { and, eq, inArray } from 'drizzle-orm';
import type { Ctx } from '../context';
import { builds } from '../db/schema';
import { docker } from './client';
import { containerPoll, containerStates, type ContainerState } from './state';
import { runtimeState } from '../state';
import { bus } from '../events';
import { log } from '../util/logger';
import { publishTray } from '../services/tray';

let timer: NodeJS.Timeout | null = null;
let events: NodeJS.ReadableStream | null = null;

/** Reads all app containers (label bm.project) into containerStates and syncs live build status. */
export async function refreshContainers(ctx: Ctx): Promise<void> {
  const list = await docker.listContainers({ all: true, filters: { label: ['bm.project'] } });
  const next = new Map<string, ContainerState>();
  for (const c of list) {
    if (c.Labels['com.docker.compose.oneoff'] === 'True') continue;
    const cp = c.Labels['com.docker.compose.project'];
    if (!cp) continue;
    const health = /\((healthy|unhealthy|health: starting)\)/.exec(c.Status)?.[1] ?? null;
    next.set(cp, {
      id: c.Id,
      name: (c.Names[0] ?? '').replace(/^\//, ''),
      state: c.State,
      health,
      buildId: c.Labels['bm.build'] ? Number(c.Labels['bm.build']) : null,
      projectId: c.Labels['bm.project']!,
      branchId: c.Labels['bm.branch'] ? Number(c.Labels['bm.branch']) : null,
      labels: c.Labels,
    });
  }
  let changed = next.size !== containerStates.size;
  for (const [k, v] of next) {
    const prev = containerStates.get(k);
    if (!prev || prev.state !== v.state || prev.buildId !== v.buildId || prev.health !== v.health) changed = true;
  }
  containerPoll.loaded = true;
  containerStates.clear();
  for (const [k, v] of next) containerStates.set(k, v);

  // Live builds follow their container: running ↔ stopped (a missing container is a discrepancy, not a status change).
  const live = ctx.db.select().from(builds).where(and(eq(builds.live, true), inArray(builds.status, ['running', 'stopped']))).all();
  let running = 0;
  for (const b of live) {
    const cs = containerStates.get(b.composeProject);
    if (!cs || cs.buildId !== b.id) continue;
    const status = cs.state === 'running' ? 'running' : 'stopped';
    if (status === 'running') running++;
    if (status !== b.status) {
      ctx.db.update(builds).set({ status }).where(eq(builds.id, b.id)).run();
      bus.emit({ type: 'build.changed', projectId: b.projectId, branchId: b.branchId, buildId: b.id });
      changed = true;
    }
  }
  runtimeState.runningBuilds = running;
  if (changed) {
    bus.emit({ type: 'system.changed' });
    bus.emit({ type: 'branch.changed' });
    publishTray(ctx);
  }
}

export function startDockerWatch(ctx: Ctx): void {
  stopDockerWatch();
  const loop = async (): Promise<void> => {
    if (runtimeState.docker.ok) await refreshContainers(ctx).catch((err) => log().debug({ err }, 'refresh containers'));
    timer = setTimeout(() => void loop(), 5000);
  };
  void loop();
  void subscribeEvents(ctx);
}

async function subscribeEvents(ctx: Ctx): Promise<void> {
  try {
    const stream = (await docker.getEvents({ filters: { type: ['container'], label: ['bm.project'] } })) as NodeJS.ReadableStream;
    events = stream;
    let pending: NodeJS.Timeout | null = null;
    stream.on('data', () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        void refreshContainers(ctx).catch(() => {});
      }, 300);
    });
    stream.on('error', () => {});
    stream.on('end', () => {
      events = null;
    });
  } catch (err) {
    log().debug({ err }, 'docker events unavailable');
  }
}

export function stopDockerWatch(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  (events as unknown as { destroy?: () => void } | null)?.destroy?.();
  events = null;
}
