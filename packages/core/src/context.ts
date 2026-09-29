import path from 'node:path';
import type Database from 'better-sqlite3';
import type { CoreToMain } from '@bm/shared';
import type { ConfigStore } from './config/store';
import type { Db } from './db';
import type { RpcServer } from './rpc';

/** Process-wide Core state, created once in startCore(). */
export interface Ctx {
  store: ConfigStore;
  db: Db;
  sqlite: Database.Database;
  rpc: RpcServer;
  dataDir: string;
  logsDir: string;
  configDir: string;
  appVersion: string;
  toMain(msg: CoreToMain): void;
  startedAt: string;
  /** Traefik port actually in use (80 or fallback). */
  proxyPort: number | null;
  /** The app's command line (D53): named pipe of the CLI server and the folder with bm.cmd / bm; null in tests. */
  cli: { pipe: string; binDir: string } | null;
}

let ctx: Ctx | null = null;

export function setCtx(c: Ctx): void {
  ctx = c;
}

export function getCtx(): Ctx {
  if (!ctx) throw new Error('Core not initialized');
  return ctx;
}

export const buildLogsDir = (c: Ctx, projectId: string): string => path.join(c.logsDir, 'builds', projectId);
export const branchDir = (c: Ctx, projectId: string, slug: string): string => path.join(c.dataDir, 'projects', projectId, 'branches', slug);
