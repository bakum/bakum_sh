import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { openDb } from '../src/db';
import { jobs } from '../src/db/schema';
import { JobQueue } from '../src/jobs/queue';
import { runtimeState } from '../src/state';
import type { Ctx } from '../src/context';

// D63: while Docker is down, jobs that need it wait in the queue instead of failing.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-queue-docker-'));
afterAll(async () => {
  runtimeState.docker.ok = false;
  // Job log streams close asynchronously after the job finishes.
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
});

const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
};

describe('job queue without Docker (D63)', () => {
  it('runs git-only jobs, holds the rest until Docker is up', async () => {
    const { db, sqlite } = openDb(path.join(tmp, 'registry.sqlite'));
    const store = { app: { limits: { maxParallelBuilds: 2 } } };
    const ctx = { store, db, sqlite, logsDir: path.join(tmp, 'logs'), toMain: () => {} } as unknown as Ctx;
    const queue = new JobQueue(ctx);
    const ran: string[] = [];
    queue.register('fetch', async () => void ran.push('fetch'));
    queue.register('build', async () => void ran.push('build'));
    const status = (id: number) => db.select().from(jobs).where(eq(jobs.id, id)).get()?.status;

    runtimeState.docker.ok = false;
    const build = queue.enqueue('build', { projectId: 'p', branchId: 1 });
    const fetch = queue.enqueue('fetch', { projectId: 'p' });
    await until(() => status(fetch) === 'success');
    await queue.pump();
    expect(ran).toEqual(['fetch']);
    expect(status(build)).toBe('queued');

    runtimeState.docker.ok = true;
    await queue.pump();
    await until(() => status(build) === 'success');
    expect(ran).toEqual(['fetch', 'build']);
    await queue.drain(2000);
    queue.stop();
    sqlite.close();
  });
});
