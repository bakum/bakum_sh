import fs from 'node:fs';
import net from 'node:net';
import type { Ctx } from '../context';
import { log } from '../util/logger';
import { runCli, type CliRequest } from './commands';
import { t } from '../i18n';

/**
 * Named pipe of the command line (D53). No TCP port: the pipe is local, and its default Windows ACL lets only the
 * current user (and administrators) write to it. On macOS it is a unix socket in the per-user temp folder, chmod 600
 * (D67). Protocol — JSON lines: the client sends one request
 * `{argv, cwd}`, Core answers with `{o: line}` / `{e: line}` and ends with `{x: exitCode}`.
 */
export function startCliServer(ctx: Ctx, pipe: string): void {
  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    let buf = '';
    let started = false;
    const send = (m: Record<string, unknown>): void => {
      if (!sock.destroyed) sock.write(`${JSON.stringify(m)}\n`);
    };
    sock.on('error', () => {});
    sock.on('data', (chunk: string) => {
      if (started) return;
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      started = true;
      let req: CliRequest;
      try {
        const v = JSON.parse(buf.slice(0, nl)) as Partial<CliRequest>;
        if (!Array.isArray(v.argv) || !v.argv.every((a) => typeof a === 'string') || typeof v.cwd !== 'string') throw new Error('bad request');
        req = { argv: v.argv, cwd: v.cwd };
      } catch {
        send({ e: t('cli.badRequest') });
        send({ x: 1 });
        sock.end();
        return;
      }
      log().info({ argv: req.argv, cwd: req.cwd }, 'cli request');
      void runCli(ctx, req, { out: (l) => send({ o: l }), err: (l) => send({ e: l }) }).then((code) => {
        send({ x: code });
        sock.end();
      });
    });
  });
  let attempts = 0;
  server.on('error', (err: NodeJS.ErrnoException) => {
    // The pipe of a Core that is still shutting down (restart): try again shortly.
    if (err.code === 'EADDRINUSE' && attempts++ < 10) {
      if (process.platform === 'win32') setTimeout(() => server.listen(pipe), 1000);
      else void removeStaleSocket(pipe).then((removed) => setTimeout(() => server.listen(pipe), removed ? 0 : 1000));
      return;
    }
    log().error({ err, pipe }, 'cli server failed');
  });
  server.listen(pipe, () => {
    if (process.platform !== 'win32') fs.chmodSync(pipe, 0o600);
    log().info({ pipe }, 'cli server listening');
  });
}

/**
 * A unix socket file outlives a Core that crashed. It is removed only when nothing answers on it (ECONNREFUSED); a
 * Core that is still alive keeps it.
 */
function removeStaleSocket(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(file);
    probe.on('connect', () => {
      probe.destroy();
      resolve(false);
    });
    probe.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'ECONNREFUSED') return resolve(false);
      try {
        if (fs.lstatSync(file).isSocket()) fs.unlinkSync(file);
        resolve(true);
      } catch {
        resolve(false);
      }
    });
  });
}
