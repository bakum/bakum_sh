import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { authorEmails, commitsBetween } from '../src/git';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-emails-'));
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const commit = (name: string, email: string, msg: string) => {
  git('-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '--allow-empty', '-m', msg);
  return git('rev-parse', 'HEAD');
};

git('init', '-q', '-b', 'main');
const a = commit('Ann', 'ann@example.com', 'first');
const b = commit('bob', '123+bob@users.noreply.github.com', 'second');

afterAll(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* Windows: read-only git objects in a temp folder, left for the OS (as in repo-mirror.test) */
  }
});

describe('commit author emails for History avatars (D65)', () => {
  it('records the author email of each commit', async () => {
    expect(await commitsBetween(dir, a, b)).toEqual([
      { sha: b, author: 'bob', email: '123+bob@users.noreply.github.com', date: expect.any(String), message: 'second' },
    ]);
  });

  it('looks emails up for older builds and leaves out commits the repository does not have', async () => {
    const missing = 'f'.repeat(40);
    expect(await authorEmails(dir, [a, missing, b])).toEqual(
      new Map([
        [a, 'ann@example.com'],
        [b, '123+bob@users.noreply.github.com'],
      ]),
    );
  });
});
