import { describe, expect, it } from 'vitest';
import { compareSemver, parseSemver } from '@bm/shared';

describe('semver (update checks)', () => {
  it('parses tags and versions with build metadata', () => {
    expect(parseSemver('v0.1.2')).toEqual({ major: 0, minor: 1, patch: 2, pre: [] });
    expect(parseSemver('0.2.0-rc.1+abc1234')).toEqual({ major: 0, minor: 2, patch: 0, pre: ['rc', '1'] });
    expect(parseSemver('latest')).toBeNull();
  });

  it('orders versions', () => {
    expect(compareSemver('0.1.2', 'v0.1.3')).toBe(-1);
    expect(compareSemver('0.2.0', '0.1.9')).toBe(1);
    expect(compareSemver('1.0.0', '1.0.0+abc')).toBe(0);
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareSemver('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1);
    expect(compareSemver('1.0.0-alpha', '1.0.0-1')).toBe(1);
    expect(compareSemver('garbage', '0.0.1')).toBe(-1);
  });
});
