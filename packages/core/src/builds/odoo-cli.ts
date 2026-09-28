import { BmError, type ProjectConfig } from '@bm/shared';
import { dockerCli } from '../docker/client';
import { dataDirOf, oneOffArgs } from '../docker/compose';
import { parseOdooLog, type OdooLogSummary } from '../odoo-log';

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
  log: (l: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<OneOffResult> {
  const lines: string[] = [];
  opts.log(`$ docker ${['compose', 'run', ...opts.cmd].join(' ')}`);
  const r = await dockerCli(oneOffArgs(opts.composeFile, opts.project, opts.volumes ?? [], opts.cmd), {
    onLine: (l) => {
      lines.push(l);
      if (lines.length > 20000) lines.splice(0, 5000);
      opts.log(l);
    },
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? 3 * 3600_000,
  });
  return { exitCode: r.exitCode, summary: parseOdooLog(lines), tail: lines.slice(-30) };
}

/** Throws a user-facing error when an Odoo run failed (exit code or CRITICAL records). */
export function assertOdooOk(r: OneOffResult, what: string): void {
  if (r.exitCode === 0 && r.summary.criticals === 0) return;
  const detail = r.summary.problems.slice(0, 3).join('\n') || r.tail.slice(-8).join('\n');
  throw new BmError('ODOO_FAILED', `${what}: Odoo завершился с ошибкой (код ${r.exitCode}).\n${detail}\nПолный вывод — в build.log (вкладка Logs).`);
}
