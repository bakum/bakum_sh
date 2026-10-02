import Docker from 'dockerode';
import type { Writable } from 'node:stream';
import { execa } from 'execa';
import { BmError } from '@bm/shared';
import { dockerSocketPath } from '../util/platform';

/** Local Docker Desktop engine only: named pipe on Windows, unix socket on macOS (D67). */
export const docker = new Docker({ socketPath: dockerSocketPath() });

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

/** The reader of our stdin is gone (the process exited): its exit code tells why, not this error. */
const STDIN_CLOSED = new Set(['EPIPE', 'ECONNRESET', 'EOF', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']);
export const isStdinClosed = (err: unknown): boolean => STDIN_CLOSED.has((err as { code?: string } | null)?.code ?? '');

/**
 * `docker …` CLI (compose, run). Argument arrays only. Output lines are streamed to `onLine` (build log).
 * `feed` writes the process's stdin (`docker run -i`); when it fails for a reason of its own (not the process having
 * exited), the process is killed and that error thrown.
 */
export async function dockerCli(
  args: string[],
  opts: { cwd?: string; onLine?: (line: string) => void; timeoutMs?: number; signal?: AbortSignal; input?: string; feed?: (stdin: Writable) => Promise<void>; env?: Record<string, string> } = {},
): Promise<RunResult> {
  const sub = execa('docker', args, {
    cwd: opts.cwd,
    reject: false,
    all: true,
    timeout: opts.timeoutMs,
    cancelSignal: opts.signal,
    windowsHide: true,
    input: opts.input,
    env: { ...opts.env, COMPOSE_ANSI: 'never', DOCKER_CLI_HINTS: 'false', MSYS_NO_PATHCONV: '1' },
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
  let feedErr: unknown = null;
  const fed = opts.feed && sub.stdin
    ? opts.feed(sub.stdin).catch((err: unknown) => {
        if (isStdinClosed(err)) return;
        feedErr = err;
        sub.kill();
      })
    : null;
  const r = await sub;
  await fed;
  if (r.isCanceled) throw new BmError('CANCELLED', 'Операция отменена');
  if (feedErr) throw feedErr;
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
