import type { BmErrorShape } from './ipc';

/** Error with a stable code and a Russian, actionable message for the user. */
export class BmError extends Error implements BmErrorShape {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'BmError';
  }

  toShape(): BmErrorShape {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function toErrorShape(err: unknown): BmErrorShape {
  if (err instanceof BmError) return err.toShape();
  if (err && typeof err === 'object' && 'issues' in err && Array.isArray((err as { issues: unknown[] }).issues)) {
    const issues = (err as { issues: { path: PropertyKey[]; message: string }[] }).issues;
    return {
      code: 'VALIDATION',
      message:
        'Некорректные данные: ' + issues.map((i) => `${i.path.map(String).join('.') || '(корень)'}: ${i.message}`).join('; '),
      details: issues,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'INTERNAL', message: `Внутренняя ошибка: ${message}. Подробности — в логе Core (Status → Открыть папку логов).` };
}
