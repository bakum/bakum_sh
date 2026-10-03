import crypto from 'node:crypto';
import path from 'node:path';
import { Transform, type Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BmError, type ProjectConfig } from '@bm/shared';
import { dockerCli, isStdinClosed, type RunResult } from './client';
import { externalPgContainer } from './postgres';
import { toPosix } from '../util/paths';
import { t } from '../i18n';

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
  /** Writes the container's stdin (`docker run -i`). */
  feed?: (stdin: Writable) => Promise<void>;
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
    ...(o.feed ? ['-i'] : []),
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
    return await dockerCli(args, { env: pg.password ? { PGPASSWORD: pg.password } : {}, onLine: o.log, feed: o.feed, signal: o.signal, timeoutMs: o.timeoutMs ?? 6 * 3600_000 });
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
  if (r.exitCode !== 0) throw new BmError('PG_DUMP', t('pgTools.dumpFailed', { src: o.src, dst: o.dst, error: tail(r) }));
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

/**
 * Plain SQL (`dump.sql` of an Odoo backup, D61) into an empty database. psql reads it from the container's stdin, so
 * nothing goes through the Docker Desktop mount of Windows folders. As in Odoo's `restore_db`, psql goes on past SQL
 * errors (they reach the log) and query results are discarded; the caller checks the database content. Progress is
 * logged every 10% of `size` (uncompressed bytes).
 */
export async function restoreSqlStream(
  o: Omit<PgToolOpts, 'script' | 'args' | 'volumes' | 'feed'> & { db: string; sql: () => Promise<Readable>; size: number; name: string },
): Promise<RunResult> {
  return runPgTool({
    ...o,
    script: 'psql -X -q -d "$1" >/dev/null',
    args: [o.db],
    feed: async (stdin) => {
      const src = await o.sql();
      let done = 0;
      let next = 10;
      const progress = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          done += chunk.length;
          const pct = o.size > 0 ? Math.floor((done * 100) / o.size) : 0;
          if (pct >= next && pct < 100) {
            o.log(`  ${o.name}: ${pct}%`);
            next = pct - (pct % 10) + 10;
          }
          cb(null, chunk);
        },
      });
      try {
        await pipeline(src, progress, stdin);
      } catch (err) {
        if (isStdinClosed(err)) throw err;
        throw new BmError('BACKUP_READ', t('pgTools.readFailed', { name: o.name, error: (err as Error).message }));
      }
    },
  });
}
