import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { commits, computeCodeLag, codeLagText } from '../src/services/code-lag';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-lag-'));
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' }).trim();
const write = (f: string, s: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
  fs.writeFileSync(path.join(dir, f), s);
};
const commit = (msg: string) => {
  git('add', '-A');
  git('commit', '-q', '-m', msg);
  return git('rev-parse', 'HEAD');
};

// main: a, b; feature forks, adds its own commit; main then changes module a twice (the «deploy»).
git('init', '-q', '-b', 'main');
write('addons/a/__manifest__.py', "{'version': '1'}");
write('addons/b/__manifest__.py', "{'version': '1'}");
const base = commit('base');
git('checkout', '-q', '-b', 'feature');
write('addons/b/models.py', '# feature');
const feature = commit('feature work');
git('checkout', '-q', 'main');
write('addons/a/models.py', '# prod 1');
commit('prod 1');
write('addons/a/__manifest__.py', "{'version': '2'}");
const prod = commit('prod 2');
git('checkout', '-q', '-b', 'merged', prod);

afterAll(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* Windows: read-only git objects in a temp folder, left for the OS (as in repo-mirror.test) */
  }
});

describe('code lag of a branch behind the copied database (D47)', () => {
  it('counts missing commits and names the modules they changed', async () => {
    expect(await computeCodeLag(dir, prod, feature, ['addons'])).toEqual({ behind: 2, ahead: 1, modules: ['a'] });
  });

  it('is zero when the branch contains the source commit', async () => {
    git('checkout', '-q', 'feature');
    git('merge', '-q', '--no-edit', 'main');
    const merged = git('rev-parse', 'HEAD');
    expect(await computeCodeLag(dir, prod, merged, ['addons'])).toEqual({ behind: 0, ahead: 2, modules: [] });
  });

  it('reports a fully merged branch left behind (nothing of its own)', async () => {
    expect(await computeCodeLag(dir, prod, base, [])).toEqual({ behind: 2, ahead: 0, modules: ['a'] });
    const text = codeLagText({ source: 'main', production: true, sourceSha: prod, behind: 2, ahead: 0, modules: ['a'] });
    expect(text).toMatch(/целиком есть в main/);
  });

  it('gives up on a commit the repository does not have', async () => {
    expect(await computeCodeLag(dir, '0123456789012345678901234567890123456789', feature, [])).toBeNull();
  });

  it('words the count in Russian', () => {
    expect([1, 2, 5, 11, 12, 21, 22, 25, 101, 111].map(commits)).toEqual([
      '1 коммит',
      '2 коммита',
      '5 коммитов',
      '11 коммитов',
      '12 коммитов',
      '21 коммит',
      '22 коммита',
      '25 коммитов',
      '101 коммит',
      '111 коммитов',
    ]);
  });
});
