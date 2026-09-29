import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli/commands';

describe('bm command line arguments (D53)', () => {
  it('reads the command, the branch, modules and options', () => {
    expect(parseArgs(['modules', 'crm', '-u', 'a,b', '-u', 'c', '-i', 'd', '-p', 'demz'])).toEqual({
      cmd: 'modules',
      args: ['crm'],
      project: 'demz',
      json: false,
      install: ['d'],
      update: ['a', 'b', 'c'],
    });
    expect(parseArgs(['test', '19.0-demz-crm', 'demz_crm', 'demz_sale,demz_x']).args).toEqual(['19.0-demz-crm', 'demz_crm', 'demz_sale', 'demz_x']);
    expect(parseArgs(['status', '--json']).json).toBe(true);
    expect(parseArgs(['--help']).cmd).toBe('help');
  });

  it('refuses what is not a module name or an option it knows', () => {
    expect(() => parseArgs(['modules', 'crm', '-u', 'demz_crm;rm'])).toThrow('не имя модуля');
    expect(() => parseArgs(['test', 'crm', 'Bad-Name'])).toThrow('не имя модуля');
    expect(() => parseArgs(['status', '--force'])).toThrow('Неизвестный параметр');
    expect(() => parseArgs(['modules', 'crm', '-u'])).toThrow('нужно значение');
  });
});
