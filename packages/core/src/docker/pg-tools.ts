import crypto from 'node:crypto';
import path from 'node:path';
import { BmError, type ProjectConfig } from '@bm/shared';
import { dockerCli, type RunResult } from './client';
import { externalPgContainer } from './postgres';
import { toPosix } from '../util/paths';

/**
 * Postgres client tools (`pg_dump`, `pg_restore`) run in a one-off container of the server's own image, in the project
 * network (D41): the tools match the server version, and the user's containers are never `docker exec`-ed into.
 */
export async function pgToolsImage(cfg: ProjectConfig): Promise<string> {
  if (cfg.postgres.mode === 'managed') return cfg.postgres.image;
  return (await externalPgContainer(cfg))?.image ?? cfg.postgres.image;
}

interface PgToolOpts {
  cfg: ProjectConfig;
  /** The build the container works for: labelled with it, so «Отбросить» removes a leftover container. */
  buildId: number;
  /** Shell script run by `sh -c`; `$1…` are `args` (never interpolated into the script). */
  script: string;
  args: string[];
  volumes?: string[];
  log: (l: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** `docker run --rm` of the Postgres image; connection in PG* variables, the password only in the environment. */
export async function runPgTool(o: PgToolOpts): Promise<RunResult> {
  const pg = o.cfg.postgres;
  const image = await pgToolsImage(o.cfg);
  const name = `bm-${o.cfg.id}-pgtool-${crypto.randomBytes(3).toString('hex')}`;
  const args = [
    'run',
    '--rm',
    '--name',
    name,
    '--network',
    o.cfg.runtime.network,
    '--label',
    `bm.project=${o.cfg.id}`,
    '--label',
    `bm.build=${o.buildId}`,
    '--label',
    'bm.oneoff=true',
    '-e',
    'PGPASSWORD',
    '-e',
    `PGHOST=${pg.internalHost}`,
    '-e',
    'PGPORT=5432',
    '-e',
    `PGUSER=${pg.user}`,
    ...(o.volumes ?? []).flatMap((v) => ['-v', v]),
    '--entrypoint',
    'sh',
    image,
    '-c',
    o.script,
    'sh',
    ...o.args,
  ];
  try {
    return await dockerCli(args, { env: pg.password ? { PGPASSWORD: pg.password } : {}, onLine: o.log, signal: o.signal, timeoutMs: o.timeoutMs ?? 6 * 3600_000 });
  } catch (err) {
    // Cancelled: the docker CLI is gone, the container may still run.
    await dockerCli(['rm', '-f', name]).catch(() => {});
    throw err;
  }
}

const tail = (r: RunResult): string => (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ');

/**
 * `cloneMethod: dump` (spec 8.3): `pg_dump -Fd -j 4` of the source into the container's temporary folder, then
 * `pg_restore -j 4` into the (empty) target. The source keeps running: pg_dump reads one consistent snapshot.
 */
export async function copyDatabaseByDump(o: Omit<PgToolOpts, 'script' | 'args' | 'volumes'> & { src: string; dst: string }): Promise<void> {
  const r = await runPgTool({
    ...o,
    script: 'set -e; d=/tmp/bm-copy; rm -rf "$d"; pg_dump -Fd -j 4 -Z 1 -f "$d" "$1"; pg_restore --no-owner --no-acl --exit-on-error -j 4 -d "$2" "$d"; rm -rf "$d"',
    args: [o.src, o.dst],
  });
  if (r.exitCode !== 0) throw new BmError('PG_DUMP', `Копирование ${o.src} → ${o.dst} через pg_dump не удалось: ${tail(r)}`);
}

/**
 * Restores a custom-format dump (`pg_dump -Fc`, the `.dump` of a production backup, spec 8.4) into an empty database.
 * The file is mounted read-only. pg_restore goes on past errors (e.g. roles of the production server) and reports them
 * with exit code 1: the caller checks the result by the database content.
 */
export async function restoreDumpFile(o: Omit<PgToolOpts, 'script' | 'args' | 'volumes'> & { file: string; db: string }): Promise<RunResult> {
  const inContainer = `/bm-backup/${path.basename(o.file)}`;
  return runPgTool({
    ...o,
    volumes: [`${toPosix(o.file)}:${inContainer}:ro`],
    script: 'pg_restore --no-owner --no-acl -j 4 -d "$1" "$2"',
    args: [o.db, inContainer],
  });
}
