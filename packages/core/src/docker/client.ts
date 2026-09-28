import Docker from 'dockerode';
import { execa } from 'execa';
import { BmError } from '@bm/shared';

/** Local Docker Desktop engine only (named pipe). */
// BM_DOCKER_PIPE exists only for the Docker-outage check without stopping Docker Desktop (docs/acceptance.md, 14).
export const docker = new Docker({ socketPath: process.env.BM_DOCKER_PIPE ?? '//./pipe/docker_engine' });

export async function dockerAlive(): Promise<{ ok: boolean; version: string | null; error: string | null }> {
  try {
    const v = await Promise.race([
      docker.version(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
    ]);
    return { ok: true, version: v.Version, error: null };
  } catch (err) {
    return { ok: false, version: null, error: (err as Error).message };
  }
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * `docker …` CLI (compose, run). Argument arrays only. Output lines are streamed to `onLine` (build log).
 */
export async function dockerCli(
  args: string[],
  opts: { cwd?: string; onLine?: (line: string) => void; timeoutMs?: number; signal?: AbortSignal; input?: string } = {},
): Promise<RunResult> {
  const sub = execa('docker', args, {
    cwd: opts.cwd,
    reject: false,
    all: true,
    timeout: opts.timeoutMs,
    cancelSignal: opts.signal,
    windowsHide: true,
    input: opts.input,
    env: { COMPOSE_ANSI: 'never', DOCKER_CLI_HINTS: 'false', MSYS_NO_PATHCONV: '1' },
  });
  if (opts.onLine) {
    let buf = '';
    sub.all?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        opts.onLine!(buf.slice(0, i).replace(/\r$/, ''));
        buf = buf.slice(i + 1);
      }
    });
    sub.all?.on('end', () => {
      if (buf) opts.onLine!(buf);
    });
  }
  const r = await sub;
  if (r.isCanceled) throw new BmError('CANCELLED', 'Операция отменена');
  return { exitCode: r.exitCode ?? -1, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
}

export async function imageExists(image: string): Promise<boolean> {
  try {
    await docker.getImage(image).inspect();
    return true;
  } catch {
    return false;
  }
}

export async function networkExists(name: string): Promise<boolean> {
  try {
    await docker.getNetwork(name).inspect();
    return true;
  } catch {
    return false;
  }
}
