import type { Discrepancy, Orphan } from '@bm/shared';

/** Runtime status shared between background services and the Status page. */
export const runtimeState = {
  docker: { ok: false, version: null as string | null, error: null as string | null, checkedAt: null as string | null },
  traefik: { ok: false, port: null as number | null, error: null as string | null },
  postgres: new Map<string, { ok: boolean; text: string }>(),
  discrepancies: [] as Discrepancy[],
  orphans: [] as Orphan[],
  queue: { running: 0, queued: 0 },
  runningBuilds: 0,
};
