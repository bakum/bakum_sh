import pg from 'pg';
import { BmError, type ProjectConfig } from '@bm/shared';
import { assertSqlIdent } from './config/templates';

type PgCfg = ProjectConfig['postgres'];

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** Safety rule 1: only the local Postgres published by Docker (external or the app's own, managed). */
function assertLocal(cfg: PgCfg): void {
  if (!LOCAL_HOSTS.has(cfg.host)) {
    throw new BmError('PG_NOT_LOCAL', `postgres.host = «${cfg.host}»: приложение работает только с локальным Postgres (localhost). Исправьте настройки проекта.`);
  }
}

export async function withPg<T>(cfg: PgCfg, database: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  assertLocal(cfg);
  if (!cfg.password) {
    throw new BmError('PG_NO_PASSWORD', 'Пароль Postgres не задан (postgres.password в настройках проекта). Укажите его в Settings → Postgres.');
  }
  const client = new pg.Client({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database,
    connectionTimeoutMillis: 5000,
    application_name: 'odoo-branch-manager',
  });
  try {
    await client.connect();
  } catch (err) {
    throw new BmError(
      'PG_CONNECT',
      `Нет подключения к Postgres ${cfg.host}:${cfg.port} (${(err as Error).message}). Проверьте, что контейнер Postgres проекта запущен и порт опубликован.`,
    );
  }
  client.on('error', () => {});
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

export async function pgPing(cfg: PgCfg): Promise<string> {
  return withPg(cfg, 'postgres', async (c) => {
    const r = await c.query<{ v: string }>("SELECT current_setting('server_version') AS v");
    return r.rows[0]?.v ?? '?';
  });
}

export async function listDatabases(cfg: PgCfg): Promise<string[]> {
  return withPg(cfg, 'postgres', async (c) => {
    const r = await c.query<{ datname: string }>('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname');
    return r.rows.map((x) => x.datname);
  });
}

export async function dbExists(cfg: PgCfg, db: string): Promise<boolean> {
  return withPg(cfg, 'postgres', async (c) => {
    const r = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [db]);
    return (r.rowCount ?? 0) > 0;
  });
}

export async function dbSize(cfg: PgCfg, db: string): Promise<number | null> {
  return withPg(cfg, 'postgres', async (c) => {
    const r = await c.query<{ s: string }>('SELECT pg_database_size($1)::text AS s', [db]);
    return r.rows[0] ? Number(r.rows[0].s) : null;
  }).catch(() => null);
}

export async function terminateConnections(c: pg.Client, db: string): Promise<void> {
  await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [db]);
}

/** `CREATE DATABASE "<db>" TEMPLATE "<src>" OWNER <user>` (spec 8.3, cloneMethod template). Idempotent. */
export async function createFromTemplate(cfg: PgCfg, db: string, src: string): Promise<void> {
  assertSqlIdent(db);
  assertSqlIdent(src, 'имя БД-источника');
  await withPg(cfg, 'postgres', async (c) => {
    const exists = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [db]);
    if ((exists.rowCount ?? 0) > 0) return;
    // Connections to the template (e.g. a running Odoo) block the copy: terminate, then retry briefly.
    for (let attempt = 0; ; attempt++) {
      await terminateConnections(c, src);
      try {
        await c.query(`CREATE DATABASE "${db}" TEMPLATE "${src}" OWNER "${assertSqlIdent(cfg.user, 'пользователь БД')}"`);
        return;
      } catch (err) {
        const msg = (err as Error).message;
        if (attempt < 5 && /being accessed by other users/.test(msg)) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        throw new BmError('PG_CLONE', `Не удалось скопировать БД ${src} → ${db}: ${msg}`);
      }
    }
  });
}

export async function createEmpty(cfg: PgCfg, db: string): Promise<void> {
  assertSqlIdent(db);
  await withPg(cfg, 'postgres', async (c) => {
    const exists = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [db]);
    if ((exists.rowCount ?? 0) > 0) return;
    await c.query(`CREATE DATABASE "${db}" OWNER "${assertSqlIdent(cfg.user, 'пользователь БД')}" ENCODING 'UTF8' TEMPLATE template0`);
  });
}

/** ALTER DATABASE … RENAME TO … (connections terminated first). Callers must pass ownership checks for both names. */
export async function renameDatabase(cfg: PgCfg, from: string, to: string): Promise<void> {
  assertSqlIdent(from);
  assertSqlIdent(to);
  if (cfg.protectedDbs.includes(from) || cfg.protectedDbs.includes(to)) throw new BmError('PROTECTED', `БД «${from}» защищена (postgres.protectedDbs)`);
  await withPg(cfg, 'postgres', async (c) => {
    for (let attempt = 0; ; attempt++) {
      await terminateConnections(c, from);
      try {
        await c.query(`ALTER DATABASE "${from}" RENAME TO "${to}"`);
        return;
      } catch (err) {
        if (attempt < 5 && /being accessed by other users/.test((err as Error).message)) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        throw new BmError('PG_RENAME', `Не удалось переименовать БД ${from} → ${to}: ${(err as Error).message}`);
      }
    }
  });
}

/** DROP DATABASE IF EXISTS. Callers must pass ownership checks (assertOwned) first. */
export async function dropDatabase(cfg: PgCfg, db: string): Promise<void> {
  assertSqlIdent(db);
  if (cfg.protectedDbs.includes(db)) throw new BmError('PROTECTED', `БД «${db}» защищена (postgres.protectedDbs)`);
  await withPg(cfg, 'postgres', async (c) => {
    await terminateConnections(c, db);
    await c.query(`DROP DATABASE IF EXISTS "${db}"`);
  });
}

const TABLES_SQL =
  "SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE c.relkind IN ('r', 'p') AND s.nspname NOT IN ('pg_catalog', 'information_schema') AND s.nspname NOT LIKE 'pg_toast%'";
const MODULES_SQL = "SELECT CASE WHEN to_regclass('ir_module_module') IS NULL THEN -1 ELSE (SELECT count(*)::int FROM ir_module_module WHERE state = 'installed') END AS n";

/** Tables and installed Odoo modules (-1 — not an Odoo database): compares a database copy with its source. */
export async function dbFingerprint(cfg: PgCfg, db: string): Promise<{ tables: number; modules: number }> {
  const [t] = await query<{ n: number }>(cfg, db, TABLES_SQL);
  const [m] = await query<{ n: number }>(cfg, db, MODULES_SQL);
  return { tables: t?.n ?? 0, modules: m?.n ?? -1 };
}

export async function query<T extends pg.QueryResultRow = Record<string, unknown>>(cfg: PgCfg, db: string, sql: string, params: unknown[] = []): Promise<T[]> {
  assertSqlIdent(db);
  return withPg(cfg, db, async (c) => (await c.query<T>(sql, params)).rows);
}

/** Runs a multi-statement SQL script in one transaction. */
export async function runScript(cfg: PgCfg, db: string, sql: string): Promise<void> {
  assertSqlIdent(db);
  await withPg(cfg, db, async (c) => {
    await c.query('BEGIN');
    try {
      await c.query(sql);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw new BmError('PG_SQL', `Ошибка SQL в БД ${db}: ${(err as Error).message}`);
    }
  });
}

export async function installedModules(cfg: PgCfg, db: string): Promise<Set<string>> {
  const rows = await query<{ name: string }>(cfg, db, "SELECT name FROM ir_module_module WHERE state = 'installed'");
  return new Set(rows.map((r) => r.name));
}

export async function pendingModules(cfg: PgCfg, db: string, names: string[] | null): Promise<string[]> {
  const rows = names
    ? await query<{ name: string }>(cfg, db, "SELECT name FROM ir_module_module WHERE state IN ('to upgrade', 'to install') AND name = ANY($1)", [names])
    : await query<{ name: string }>(cfg, db, "SELECT name FROM ir_module_module WHERE state IN ('to upgrade', 'to install')");
  return rows.map((r) => r.name);
}
