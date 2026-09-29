import { BmError, type ProjectConfig, type TestsResult } from '@bm/shared';
import { dockerCli } from '../docker/client';
import { dataDirOf, oneOffArgs } from '../docker/compose';
import { OdooLogParser, type OdooLogSummary } from '../odoo-log';

/**
 * Server options of the configured command, reusable for one-off runs: everything after the Odoo executable
 * except the per-build ones (-d, --db-filter, --proxy-mode). DEMZ: `-c /etc/odoo/odoo.conf --data-dir=/var/lib/odoo`.
 */
export function serverBaseArgs(cfg: ProjectConfig): string[] {
  const cmd = cfg.runtime.command;
  const i = cmd.findIndex((a) => /(^|\/)(odoo|odoo-bin)$/.test(a));
  const rest = i >= 0 ? cmd.slice(i + 1) : [];
  const out: string[] = [];
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k]!;
    if (a === '-d' || a === '--database') {
      k++;
      continue;
    }
    if (a.startsWith('--database=') || a.startsWith('--db-filter') || a === '--proxy-mode') continue;
    if (a.includes('{')) continue;
    out.push(a);
  }
  if (!out.some((a) => a.startsWith('--data-dir') || a === '-D')) out.push(`--data-dir=${dataDirOf(cfg)}`);
  return out;
}

/** Major Odoo version of the project (`runtime.odooVersion`), null when it is not a number (D38). */
export function odooMajor(cfg: ProjectConfig): number | null {
  const m = /^(\d+)/.exec(cfg.runtime.odooVersion.trim());
  return m ? Number(m[1]) : null;
}

/**
 * Demo data options for the first `-i` into a fresh database (D38): Odoo 19 loads demo only with `--with-demo`,
 * Odoo 16–18 load it by default and have no `--with-demo`. An unknown version is treated as 19.
 */
export function demoArgs(cfg: ProjectConfig, withDemo: boolean): string[] {
  const major = odooMajor(cfg);
  if (major === null || major >= 19) return withDemo ? ['--with-demo'] : [];
  return withDemo ? [] : ['--without-demo=all'];
}

/**
 * Options for `odoo db …` / `odoo neutralize`: Odoo 19 must not get `-c` before the subcommand, the config comes
 * from ODOO_RC (/etc/odoo/odoo.conf). Connection and addons options of the server command are passed after it.
 */
export function dbSubcommandOptions(cfg: ProjectConfig): string[] {
  const out = [`-D`, dataDirOf(cfg)];
  for (const a of serverBaseArgs(cfg)) {
    if (a.startsWith('--addons-path=') || a.startsWith('--db_host=') || a.startsWith('--db_port=')) out.push(a);
    else if (a.startsWith('--db_user=')) out.push('-r', a.slice('--db_user='.length));
  }
  return out;
}

/**
 * One-off `odoo db <sub…>` (D38). The executable is called by its path: the official entrypoint appends `--db_host …
 * --db_password …` to a command starting with `odoo` (Odoo 16–18 always, 19 without PG* variables), i.e. after the
 * subcommand's own arguments, where `odoo db` rejects them. The password reaches libpq as PGPASSWORD.
 */
export function dbSubcommand(cfg: ProjectConfig, sub: string[]): { cmd: string[]; env: Record<string, string> } {
  return {
    cmd: ['/usr/bin/odoo', 'db', ...dbSubcommandOptions(cfg), ...sub],
    env: cfg.postgres.password ? { PGPASSWORD: cfg.postgres.password } : {},
  };
}

/** Failed or errored tests in a result. */
export const testsFailed = (t: TestsResult | null | undefined): boolean => !!t && t.failed + t.errors > 0;

/**
 * `--test-enable --test-tags …` for the given modules (spec 8.8): `tests.tags` is a template per module
 * (`/{module}` by default); without `{module}` it is used as is.
 */
export function testArgs(tests: { tags: string; extraArgs: string[] }, modules: string[]): string[] {
  const tpl = tests.tags.trim() || '/{module}';
  const tags = tpl.includes('{module}') ? modules.map((m) => tpl.replaceAll('{module}', m)) : [tpl];
  return ['--test-enable', '--test-tags', [...new Set(tags)].join(','), ...tests.extraArgs];
}

export interface OneOffResult {
  exitCode: number;
  summary: OdooLogSummary;
  tail: string[];
}

/** `docker compose run --rm odoo <cmd>` with output streamed to the build log and parsed. */
export async function runOdooOneOff(opts: {
  composeFile: string;
  project: string;
  cmd: string[];
  volumes?: string[];
  /** Variables for the container, passed by name from the docker CLI environment (values are not logged). */
  env?: Record<string, string>;
  log: (l: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<OneOffResult> {
  const tail: string[] = [];
  const parser = new OdooLogParser();
  opts.log(`$ docker ${['compose', 'run', ...opts.cmd].join(' ')}`);
  const r = await dockerCli(oneOffArgs(opts.composeFile, opts.project, opts.volumes ?? [], opts.cmd, Object.keys(opts.env ?? {})), {
    env: opts.env,
    onLine: (l) => {
      parser.push(l);
      tail.push(l);
      if (tail.length > 60) tail.splice(0, 30);
      opts.log(l);
    },
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? 3 * 3600_000,
  });
  return { exitCode: r.exitCode, summary: parser.result(), tail: tail.slice(-30) };
}

/**
 * Throws a user-facing error when an Odoo run failed (exit code or CRITICAL records). With `--stop-after-init`
 * Odoo also exits with code 1 when tests failed: that is a test result, not a failed run.
 */
export function assertOdooOk(r: OneOffResult, what: string): void {
  if (r.summary.criticals === 0 && (r.exitCode === 0 || testsFailed(r.summary.tests))) return;
  const detail = r.summary.problems.slice(0, 3).join('\n') || r.tail.slice(-8).join('\n');
  throw new BmError('ODOO_FAILED', `${what}: Odoo завершился с ошибкой (код ${r.exitCode}).\n${detail}\nПолный вывод — в build.log (вкладка Logs).`);
}
