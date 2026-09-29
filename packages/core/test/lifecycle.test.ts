import { describe, expect, it } from 'vitest';
import { lifecycleState } from '../src/builds/lifecycle-state';
import { isBackgroundRequest, parseAccessLine } from '../src/services/activity';
import { statsSample } from '../src/services/monitor';

const H = 3_600_000;
const D = 24 * H;
const base = Date.parse('2026-09-29T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('build lifecycle (D45)', () => {
  const input = {
    running: true,
    startedAt: iso(base),
    finishedAt: iso(base - D),
    lastActiveAt: iso(base + 2 * H),
    idleStopHours: 8,
    dropAfterDays: 14,
    now: base + 3 * H,
  };

  it('stops a running build 8 h after the last request, the start or the build', () => {
    const s = lifecycleState(input);
    expect(s.stopAt).toBe(base + 10 * H);
    expect(s.stopNow).toBe(false);
    expect(lifecycleState({ ...input, now: base + 10 * H }).stopNow).toBe(true);
    // A manual Start after the last request restarts the timer.
    expect(lifecycleState({ ...input, startedAt: iso(base + 5 * H) }).stopAt).toBe(base + 13 * H);
    // No requests at all: counted from the start of the container.
    expect(lifecycleState({ ...input, lastActiveAt: null }).stopAt).toBe(base + 8 * H);
  });

  it('never stops a stopped build or with idleStopHours 0', () => {
    expect(lifecycleState({ ...input, running: false }).stopAt).toBeNull();
    expect(lifecycleState({ ...input, idleStopHours: 0 }).stopAt).toBeNull();
  });

  it('expires dropAfterDays after the last activity or the build, whichever is later', () => {
    expect(lifecycleState(input).expiresAt).toBe(base + 2 * H + 14 * D);
    expect(lifecycleState({ ...input, lastActiveAt: null }).expiresAt).toBe(base - D + 14 * D);
    expect(lifecycleState({ ...input, now: base + 2 * H + 14 * D }).expired).toBe(true);
    expect(lifecycleState({ ...input, dropAfterDays: 0 }).expiresAt).toBeNull();
  });
});

describe('Traefik access log', () => {
  const line = JSON.stringify({
    RouterName: 'bm-demz-crm@docker',
    RequestHost: 'crm.localhost:8080',
    RequestPath: '/odoo/action-123',
    DownstreamStatus: 200,
    Duration: 42_500_000,
    StartUTC: '2026-09-29T10:00:01.123456789Z',
  });

  it('reads router, path, status, duration and time', () => {
    expect(parseAccessLine(line)).toEqual({ router: 'bm-demz-crm', path: '/odoo/action-123', status: 200, durationMs: 42.5, at: '2026-09-29T10:00:01.123456789Z' });
  });

  it('ignores Traefik own log lines and requests without a router', () => {
    expect(parseAccessLine('time="2026-09-29T10:00:00Z" level=warning msg="x"')).toBeNull();
    expect(parseAccessLine('{"level":"warn","msg":"x"}')).toBeNull();
    expect(parseAccessLine('{broken')).toBeNull();
  });

  it('does not count the background channels of an open tab as activity', () => {
    expect(isBackgroundRequest('/websocket')).toBe(true);
    expect(isBackgroundRequest('/longpolling/poll')).toBe(true);
    expect(isBackgroundRequest('/bus/im_status')).toBe(true);
    expect(isBackgroundRequest('/web/login')).toBe(false);
  });
});

describe('docker stats sample', () => {
  it('computes CPU % of one core and RAM without the page cache', () => {
    const s = statsSample({
      cpu_stats: { cpu_usage: { total_usage: 3_000_000 }, system_cpu_usage: 20_000_000, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 10_000_000 },
      memory_stats: { usage: 600 * 1048576, limit: 8192 * 1048576, stats: { inactive_file: 100 * 1048576 } },
    });
    expect(s).toEqual({ cpu: 80, memMb: 500, limitMb: 8192 });
  });
});
