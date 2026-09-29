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
// "0 failed, 1 error(s) of 12 tests when loading database 'x'" (Odoo 16–19)
const TEST_SUMMARY = /(\d+) failed, (\d+) error\(s\) of (\d+) tests/;
const TEST_FAIL = /^(FAIL|ERROR): (\S+)/;
/** Loggers of test code: `odoo.tests.*` and `odoo.addons.<module>.tests.*`. */
const TEST_LOGGER = /^odoo\.(tests|addons\.\w+\.tests)(\.|$)/;

/**
 * Incremental parser of Odoo server output (spec 8.8): counts WARNING / ERROR / CRITICAL records, the test summary
 * line, FAIL: / ERROR: entries. Lines that are not log records (tracebacks) belong to the previous record. Test
 * warnings (orange status) are WARNING records of test loggers only: installing modules logs warnings of its own.
 */
export class OdooLogParser {
  private s: OdooLogSummary = { errors: 0, criticals: 0, warnings: 0, problems: [], tests: null };
  private total: number | null = null;
  private failed = 0;
  private errored = 0;
  private testWarnings = 0;
  private failures = new Set<string>();

  push(raw: string): void {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    const m = RECORD.exec(line);
    if (m) {
      const [, level, , logger, msg] = m;
      if (level === 'WARNING') {
        this.s.warnings++;
        if (TEST_LOGGER.test(logger!)) this.testWarnings++;
      } else if (level === 'ERROR') {
        this.s.errors++;
        if (this.s.problems.length < 10) this.s.problems.push(`${logger}: ${msg}`);
      } else if (level === 'CRITICAL') {
        this.s.criticals++;
        if (this.s.problems.length < 10) this.s.problems.push(`${logger}: ${msg}`);
      }
      const t = TEST_SUMMARY.exec(msg!);
      if (t) {
        this.failed = Number(t[1]);
        this.errored = Number(t[2]);
        this.total = Number(t[3]);
      }
      const f = TEST_FAIL.exec(msg!);
      if (f) this.failures.add(`${f[1]}: ${f[2]}`);
      return;
    }
    const f = TEST_FAIL.exec(line);
    if (f) this.failures.add(`${f[1]}: ${f[2]}`);
  }

  result(): OdooLogSummary {
    const tests =
      this.total === null
        ? null
        : {
            passed: Math.max(0, this.total - this.failed - this.errored),
            failed: this.failed,
            errors: this.errored,
            warnings: this.testWarnings,
            failures: [...this.failures],
          };
    return { ...this.s, problems: [...this.s.problems], tests };
  }
}

export function parseOdooLog(lines: Iterable<string>): OdooLogSummary {
  const p = new OdooLogParser();
  for (const l of lines) p.push(l);
  return p.result();
}
