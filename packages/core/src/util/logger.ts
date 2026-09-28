import fs from 'node:fs';
import path from 'node:path';
import pino, { type Logger } from 'pino';

let root: Logger = pino({ level: 'info' });

/** Core log: <dataDir>/logs/core.log (pino JSON lines). */
export function initLogger(logsDir: string): Logger {
  fs.mkdirSync(logsDir, { recursive: true });
  root = pino(
    { level: process.env.BM_LOG_LEVEL ?? 'info', base: { proc: 'core' } },
    pino.destination({ dest: path.join(logsDir, 'core.log'), sync: false, mkdir: true }),
  );
  return root;
}

export const log = (): Logger => root;
