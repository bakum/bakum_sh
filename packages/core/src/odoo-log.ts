import type { TestsResult } from '@bm/shared';

export interface OdooLogSummary {
  errors: number;
  criticals: number;
  warnings: number;
  /** First line of each traceback block / ERROR+ record, for the build error message. */
  problems: string[];
  tests: TestsResult | null;
}

const RECORD = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3} \d+ (DEBUG|INFO|WARNING|ERROR|CRITICAL) (\S+) ([\w.]+): (.*)$/;
// "0 failed, 1 error(s) of 12 tests when loading database 'x'" (Odoo 17–19)
const TEST_SUMMARY = /(\d+) failed, (\d+) error\(s\) of (\d+) tests/;
const TEST_FAIL = /^(FAIL|ERROR): (\S+)/;

/**
 * Parses Odoo server output (spec 8.8): counts WARNING / ERROR / CRITICAL records, test summary line,
 * FAIL: / ERROR: entries. Lines that are not log records (tracebacks) belong to the previous record.
 */
export function parseOdooLog(lines: Iterable<string>): OdooLogSummary {
  const s: OdooLogSummary = { errors: 0, criticals: 0, warnings: 0, problems: [], tests: null };
  let passedTotal: number | null = null;
  let failed = 0;
  let errored = 0;
  const failures: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    const m = RECORD.exec(line);
    if (m) {
      const [, level, , logger, msg] = m;
      if (level === 'WARNING') s.warnings++;
      else if (level === 'ERROR') {
        s.errors++;
        if (s.problems.length < 10) s.problems.push(`${logger}: ${msg}`);
      } else if (level === 'CRITICAL') {
        s.criticals++;
        if (s.problems.length < 10) s.problems.push(`${logger}: ${msg}`);
      }
      const t = TEST_SUMMARY.exec(msg!);
      if (t) {
        failed = Number(t[1]);
        errored = Number(t[2]);
        passedTotal = Number(t[3]);
      }
      const f = TEST_FAIL.exec(msg!);
      if (f) failures.push(`${f[1]}: ${f[2]}`);
      continue;
    }
    const f = TEST_FAIL.exec(line);
    if (f) failures.push(`${f[1]}: ${f[2]}`);
  }
  if (passedTotal !== null) {
    s.tests = {
      passed: Math.max(0, passedTotal - failed - errored),
      failed,
      errors: errored,
      warnings: s.warnings,
      failures: [...new Set(failures)],
    };
  }
  return s;
}
