/**
 * Build lifecycle dates (spec 8.3, D45): `idleStopHours` stops a running live build nobody opened for that long;
 * `dropAfterDays` marks the date after which the build may be dropped — the app warns, dropping stays the user's.
 */
export interface LifecycleInput {
  running: boolean;
  /** When the container was (re)started: a manual Start restarts the idle timer. */
  startedAt: string | null;
  /** When the build finished (a new commit gives a new or updated build). */
  finishedAt: string | null;
  /** Last HTTP request to the branch through Traefik. */
  lastActiveAt: string | null;
  idleStopHours: number;
  dropAfterDays: number;
  now: number;
}

export interface LifecycleState {
  /** Time the build stops for inactivity; null — never (not running or idleStopHours 0). */
  stopAt: number | null;
  /** Time after which the build may be dropped; null — never (dropAfterDays 0). */
  expiresAt: number | null;
  stopNow: boolean;
  expired: boolean;
}

const t = (iso: string | null): number => (iso ? new Date(iso).getTime() || 0 : 0);

export function lifecycleState(i: LifecycleInput): LifecycleState {
  const activity = Math.max(t(i.lastActiveAt), t(i.finishedAt));
  const stopAt = i.running && i.idleStopHours > 0 ? Math.max(activity, t(i.startedAt)) + i.idleStopHours * 3_600_000 : null;
  const expiresAt = i.dropAfterDays > 0 && activity > 0 ? activity + i.dropAfterDays * 86_400_000 : null;
  return { stopAt, expiresAt, stopNow: stopAt !== null && i.now >= stopAt, expired: expiresAt !== null && i.now >= expiresAt };
}
