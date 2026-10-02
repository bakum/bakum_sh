import { describe, expect, it } from 'vitest';
import { inPortRanges, parseBsdNetstat, parseExcludedPortRanges, parseWindowsNetstat } from '../src/util/ports';

describe('excluded port ranges (D62)', () => {
  const out = [
    '',
    'Протокол tcp Диапазоны исключенных портов',
    '',
    'Начальный порт    Конечный порт',
    '----------    --------',
    '      5357        5357',
    '     50000       50059     *',
    '     55418       55517',
    '',
    '* - Управляемые исключения портов.',
  ].join('\r\n');

  it('reads the numeric rows only', () => {
    expect(parseExcludedPortRanges(out)).toEqual([[5357, 5357], [50000, 50059], [55418, 55517]]);
  });

  it('matches ports inside a range, bounds included', () => {
    const r = parseExcludedPortRanges(out);
    expect(inPortRanges(55432, r)).toBe(true);
    expect(inPortRanges(55517, r)).toBe(true);
    expect(inPortRanges(15432, r)).toBe(false);
  });
});

describe('listening ports from netstat', () => {
  it('Windows', () => {
    const out = [
      'Active Connections',
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:80             0.0.0.0:0              LISTENING       4',
      '  TCP    127.0.0.1:5433         0.0.0.0:0              LISTENING       9120',
      '  TCP    [::]:8080              [::]:0                 LISTENING       9120',
      '  TCP    127.0.0.1:50123        127.0.0.1:5433         ESTABLISHED     700',
    ].join('\r\n');
    expect([...parseWindowsNetstat(out)].sort((a, b) => a - b)).toEqual([80, 5433, 8080]);
  });

  it('macOS (D67)', () => {
    const out = [
      'Active Internet connections (including servers)',
      'Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)',
      'tcp4       0      0  127.0.0.1.5433         *.*                    LISTEN',
      'tcp46      0      0  *.8080                 *.*                    LISTEN',
      'tcp6       0      0  ::1.631                *.*                    LISTEN',
      'tcp4       0      0  192.168.1.5.50123      17.57.144.1.443        ESTABLISHED',
    ].join('\n');
    expect([...parseBsdNetstat(out)].sort((a, b) => a - b)).toEqual([631, 5433, 8080]);
  });
});
