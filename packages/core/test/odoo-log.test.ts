import { describe, expect, it } from 'vitest';
import { OdooLogParser, parseOdooLog } from '../src/odoo-log';

const log = `2026-09-28 08:00:01,123 7 INFO o19_br_crm_3 odoo.modules.loading: loading 120 modules...
2026-09-28 08:00:02,456 7 WARNING o19_br_crm_3 odoo.addons.base.models.ir_model: Two fields (x, y) have the same label
2026-09-28 08:00:03,789 7 ERROR o19_br_crm_3 odoo.modules.registry: Failed to load registry
Traceback (most recent call last):
  File "/usr/lib/python3/dist-packages/odoo/modules/registry.py", line 110, in new
    odoo.modules.load_modules(registry, force_demo, status, update_module)
ValueError: boom
2026-09-28 08:00:04,000 7 CRITICAL o19_br_crm_3 odoo.service.server: Failed to initialize database \`o19_br_crm_3\`.
2026-09-28 08:00:05,000 7 INFO o19_br_crm_3 odoo.tests.stats: demz_crm_lead: 12 tests 0.30s 110 queries
2026-09-28 08:00:05,100 7 ERROR o19_br_crm_3 odoo.addons.demz_crm_lead.tests.test_lead: FAIL: TestLead.test_assign
2026-09-28 08:00:06,000 7 ERROR o19_br_crm_3 odoo.tests.result: 1 failed, 1 error(s) of 12 tests when loading database 'o19_br_crm_3'
`;

describe('parseOdooLog (spec 8.8)', () => {
  it('counts levels and keeps the problems', () => {
    const r = parseOdooLog(log.split('\n'));
    expect(r.warnings).toBe(1);
    expect(r.errors).toBe(3);
    expect(r.criticals).toBe(1);
    expect(r.problems[0]).toBe('odoo.modules.registry: Failed to load registry');
    expect(r.problems).toContain('odoo.service.server: Failed to initialize database `o19_br_crm_3`.');
  });

  it('reads the test summary and FAIL entries', () => {
    const r = parseOdooLog(log.split('\n'));
    // The WARNING comes from module loading, not from a test: tests stay green-or-red, not orange.
    expect(r.tests).toEqual({ passed: 10, failed: 1, errors: 1, warnings: 0, failures: ['FAIL: TestLead.test_assign'] });
  });

  it('counts warnings of test loggers as test warnings, parsing line by line', () => {
    const p = new OdooLogParser();
    for (const l of [
      '2026-09-28 08:00:01,000 7 WARNING db odoo.addons.base.models.ir_model: install warning',
      '2026-09-28 08:00:02,000 7 WARNING db odoo.addons.demz_crm.tests.test_lead: deprecated call in test',
      '2026-09-28 08:00:02,500 7 WARNING db odoo.tests.common: unclosed cursor',
      '2026-09-28 08:00:03,000 7 INFO db odoo.tests.result: 0 failed, 0 error(s) of 4 tests when loading database \'db\'',
    ]) {
      p.push(l);
    }
    const r = p.result();
    expect(r.warnings).toBe(3);
    expect(r.tests).toEqual({ passed: 4, failed: 0, errors: 0, warnings: 2, failures: [] });
  });

  it('reads the Odoo 16 ERROR: entries with a traceback on the next lines', () => {
    const r = parseOdooLog([
      '2026-09-28 08:00:01,000 7 ERROR db odoo.addons.x.tests.test_a: ERROR: TestA.test_b',
      'Traceback (most recent call last):',
      '  File "/mnt/x/tests/test_a.py", line 10, in test_b',
      'KeyError: 1',
      '2026-09-28 08:00:02,000 7 ERROR db odoo.service.server: 0 failed, 1 error(s) of 2 tests when loading database \'db\'',
    ]);
    expect(r.tests).toEqual({ passed: 1, failed: 0, errors: 1, warnings: 0, failures: ['ERROR: TestA.test_b'] });
  });

  it('reports no tests when there is no summary line and ignores ANSI colours', () => {
    const r = parseOdooLog(['\x1b[1;31m2026-09-28 08:00:01,123 7 ERROR db x.y: bad\x1b[0m', 'plain line']);
    expect(r.tests).toBeNull();
    expect(r.errors).toBe(1);
  });
});
