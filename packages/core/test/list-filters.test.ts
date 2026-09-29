import { describe, expect, it } from 'vitest';
import type { TestsResult } from '@bm/shared';
import type { Ctx } from '../src/context';
import { openDb } from '../src/db';
import { auditLog, branches, builds } from '../src/db/schema';
import { listBuilds } from '../src/builds/view';
import { listAudit } from '../src/services/audit';

function registry() {
  const { db } = openDb(':memory:');
  const ctx = { db, proxyPort: 80 } as unknown as Ctx;
  const at = (d: string) => `2026-09-${d}T10:00:00.000Z`;
  db.insert(branches).values([
    { id: 1, projectId: 'p', name: 'main', slug: 'prod', stage: 'production', assignedBy: 'user', createdAt: at('01') },
    { id: 2, projectId: 'p', name: 'feature', slug: 'feature', stage: 'development', assignedBy: 'rule', createdAt: at('01') },
    { id: 3, projectId: 'q', name: 'main', slug: 'prod', stage: 'production', assignedBy: 'user', createdAt: at('01') },
  ]).run();
  const tests = (failed: number, errors = 0): TestsResult => ({ passed: 3, failed, errors, warnings: 0, failures: [] });
  const build = (id: number, branchId: number, over: Partial<typeof builds.$inferInsert>) => ({
    id,
    branchId,
    projectId: branchId === 3 ? 'q' : 'p',
    number: id,
    stage: branchId === 2 ? ('development' as const) : ('production' as const),
    trigger: 'rebuild' as const,
    kind: 'new' as const,
    dbSource: 'fresh',
    dbName: `db_${id}`,
    host: 'h.localhost',
    composeProject: `bm-p-${id}`,
    status: 'dropped' as const,
    createdAt: at('10'),
    ...over,
  });
  db.insert(builds).values([
    build(1, 1, { status: 'running', createdAt: at('05') }),
    build(2, 2, { tests: tests(1), createdAt: at('10') }),
    build(3, 2, { tests: tests(0, 2), trigger: 'new_commit', createdAt: at('12') }),
    build(4, 2, { tests: tests(0), status: 'running', trigger: 'new_commit', createdAt: at('20') }),
    build(5, 3, { createdAt: at('20') }),
  ]).run();
  db.insert(auditLog).values([
    { projectId: 'p', at: at('10'), action: 'build.success', target: 'feature#4', params: {}, result: 'ok' },
    { projectId: 'p', at: at('11'), action: 'build.failed', target: 'feature#3', params: { step: 'tests', error: 'Тесты не прошли' }, result: 'failed' },
    { projectId: 'p', at: at('12'), action: 'settings.update', target: 'p.yaml', params: {}, result: 'ok', diff: '- a: 1\n+ a: 2' },
    { projectId: null, at: at('13'), action: 'settings.update', target: 'app.yaml', params: {}, result: 'ok', diff: '+ x: 1' },
    { projectId: 'q', at: at('14'), action: 'build.success', target: 'main#5', params: {}, result: 'ok' },
  ]).run();
  return ctx;
}

const ids = (r: { items: { id: number }[] }) => r.items.map((x) => x.id);
const page = { offset: 0, limit: 20 };

describe('Builds filters (spec 8.11)', () => {
  const ctx = registry();
  it('filters by project, branch, stage, status and trigger', () => {
    expect(ids(listBuilds(ctx, { projectId: 'p', ...page }))).toEqual([4, 3, 2, 1]);
    expect(ids(listBuilds(ctx, { projectId: 'p', branchId: 2, ...page }))).toEqual([4, 3, 2]);
    expect(ids(listBuilds(ctx, { projectId: 'p', stage: 'production', ...page }))).toEqual([1]);
    expect(ids(listBuilds(ctx, { projectId: 'p', status: 'running', ...page }))).toEqual([4, 1]);
    expect(ids(listBuilds(ctx, { projectId: 'p', trigger: 'new_commit', ...page }))).toEqual([4, 3]);
  });
  it('filters by test result: failures and errors both count as failed', () => {
    expect(ids(listBuilds(ctx, { projectId: 'p', tests: 'failed', ...page }))).toEqual([3, 2]);
    expect(ids(listBuilds(ctx, { projectId: 'p', tests: 'passed', ...page }))).toEqual([4]);
    expect(ids(listBuilds(ctx, { projectId: 'p', tests: 'none', ...page }))).toEqual([1]);
  });
  it('filters by date range and pages on the server with the full total', () => {
    expect(ids(listBuilds(ctx, { projectId: 'p', since: '2026-09-10T00:00:00.000Z', until: '2026-09-13T00:00:00.000Z', ...page }))).toEqual([3, 2]);
    const p2 = listBuilds(ctx, { projectId: 'p', offset: 2, limit: 2 });
    expect(ids(p2)).toEqual([2, 1]);
    expect(p2.total).toBe(4);
  });
});

describe('Audit filters (spec 8.11)', () => {
  const ctx = registry();
  const base = { projectId: 'p', withApp: false, ...page };
  it('keeps the project scope, optionally with app-level records', () => {
    expect(listAudit(ctx, base).total).toBe(3);
    const withApp = listAudit(ctx, { ...base, withApp: true });
    expect(withApp.total).toBe(4);
    expect(withApp.actions).toEqual(['build.failed', 'build.success', 'settings.update']);
  });
  it('filters by action group or exact action, text, result and time', () => {
    expect(listAudit(ctx, { ...base, action: 'build.' }).items.map((a) => a.target)).toEqual(['feature#3', 'feature#4']);
    expect(listAudit(ctx, { ...base, action: 'build.success' }).total).toBe(1);
    // The text is looked up in the parameters too, case-insensitively.
    expect(listAudit(ctx, { ...base, q: 'ТЕСТЫ' }).items.map((a) => a.target)).toEqual(['feature#3']);
    expect(listAudit(ctx, { ...base, result: 'error' }).items.map((a) => a.action)).toEqual(['build.failed']);
    expect(listAudit(ctx, { ...base, since: '2026-09-11T00:00:00.000Z' }).total).toBe(2);
  });
  it('returns parameters and settings diffs', () => {
    const [s] = listAudit(ctx, { ...base, action: 'settings.update' }).items;
    expect(s?.diff).toBe('- a: 1\n+ a: 2');
    const [f] = listAudit(ctx, { ...base, result: 'error' }).items;
    expect(f?.params).toEqual({ step: 'tests', error: 'Тесты не прошли' });
  });
});
