import { describe, expect, it } from 'vitest';
import { inPortRanges, parseExcludedPortRanges } from '../src/util/ports';

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
