import { describe, expect, it } from 'vitest';
import { bucketRequests, bucketResources } from '../src/services/monitor';

describe('Monitor over a period (D74)', () => {
  const samples = [
    { at: '2026-10-03T10:00:00', cpu: 10, memMb: 500 },
    { at: '2026-10-03T10:00:30', cpu: 20, memMb: 700 },
    { at: '2026-10-03T10:03:10', cpu: 5, memMb: 600 },
  ];

  it('keeps the raw 30 s samples for an hour', () => {
    expect(bucketResources(samples, 30)).toEqual([
      { at: '2026-10-03T10:00:00Z', cpu: 10, memMb: 500 },
      { at: '2026-10-03T10:00:30Z', cpu: 20, memMb: 700 },
      { at: '2026-10-03T10:03:10Z', cpu: 5, memMb: 600 },
    ]);
  });

  it('averages samples into buckets stamped with their start', () => {
    expect(bucketResources(samples, 180)).toEqual([
      { at: '2026-10-03T10:00:00.000Z', cpu: 15, memMb: 600 },
      { at: '2026-10-03T10:03:00.000Z', cpu: 5, memMb: 600 },
    ]);
  });

  it('sums requests per bucket, keeps the worst time', () => {
    const rows = [
      { minute: '2026-10-03T10:00', count: 2, total: 200, max: 150, errors: 0 },
      { minute: '2026-10-03T10:02', count: 3, total: 900, max: 600, errors: 1 },
      { minute: '2026-10-03T10:12', count: 1, total: 50, max: 50, errors: 0 },
    ];
    expect(bucketRequests(rows, 30)).toHaveLength(3);
    expect(bucketRequests(rows, 720)).toEqual([
      { minute: '2026-10-03T10:00', count: 5, avgMs: 220, maxMs: 600, errors: 1 },
      { minute: '2026-10-03T10:12', count: 1, avgMs: 50, maxMs: 50, errors: 0 },
    ]);
  });
});
