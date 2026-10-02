import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dockerRunWithEnvFile, dockerSocketPath, shQuote, withExtraPath } from '../src/util/platform';
import { isInside, samePath } from '../src/util/paths';

describe('macOS support (D67)', () => {
  it('finds the Docker socket', () => {
    const none = (): boolean => false;
    expect(dockerSocketPath({}, 'win32', none, 'C:/Users/u')).toBe('//./pipe/docker_engine');
    expect(dockerSocketPath({ BM_DOCKER_PIPE: '//./pipe/bm_sim' }, 'win32', none)).toBe('//./pipe/bm_sim');
    expect(dockerSocketPath({ DOCKER_HOST: 'unix:///tmp/d.sock' }, 'darwin', none, '/Users/u')).toBe('/tmp/d.sock');
    expect(dockerSocketPath({}, 'darwin', (p) => p === '/Users/u/.docker/run/docker.sock', '/Users/u')).toBe('/Users/u/.docker/run/docker.sock');
    expect(dockerSocketPath({}, 'darwin', none, '/Users/u')).toBe('/var/run/docker.sock');
  });

  it('appends missing PATH folders without reordering', () => {
    expect(withExtraPath('/usr/bin:/bin:/usr/local/bin', ['/opt/homebrew/bin', '/usr/local/bin'])).toBe('/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin');
    expect(withExtraPath(undefined, ['/a'])).toBe('/a');
  });

  it('quotes Terminal arguments for the shell', () => {
    expect(['docker', 'exec', '-it', 'bm-shop-main-web-1', 'bash'].map(shQuote).join(' ')).toBe('docker exec -it bm-shop-main-web-1 bash');
    expect(shQuote("it's $HOME")).toBe(`'it'\\''s $HOME'`);
    expect(shQuote('')).toBe("''");
  });

  it('moves secret variables of docker run into an env file', () => {
    const argv = ['docker', 'run', '--rm', '-it', '--network', 'bm-shop', '-e', 'PGPASSWORD', 'odoo:18', 'psql', '-e', 'x'];
    expect(dockerRunWithEnvFile(argv, ['PGPASSWORD'], '/tmp/env')).toEqual(['docker', 'run', '--env-file', '/tmp/env', '--rm', '-it', '--network', 'bm-shop', 'odoo:18', 'psql', '-e', 'x']);
    expect(dockerRunWithEnvFile(['docker', 'exec', 'c', 'bash'], ['PGPASSWORD'], '/tmp/env')).toEqual(['docker', 'exec', 'c', 'bash']);
  });

  it.skipIf(process.platform === 'win32')('compares paths through symlinks, also for paths that do not exist yet', () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-real-'));
    const link = `${real}-link`;
    fs.symlinkSync(real, link);
    try {
      expect(samePath(link, real)).toBe(true);
      expect(isInside(link, path.join(real, 'worktrees', 'new'))).toBe(true);
      expect(isInside(real, path.join(link, 'a'))).toBe(true);
      expect(isInside(real, `${real}-other`)).toBe(false);
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(real, { recursive: true, force: true });
    }
  });
});
