import type { MethodName, MethodParams, MethodResult } from '@bm/shared';

export interface BmCallError extends Error {
  code?: string;
  details?: unknown;
}

export function call<K extends MethodName>(method: K, params: MethodParams<K>): Promise<MethodResult<K>> {
  return window.bm.call(method, params);
}

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
export const errorCode = (e: unknown): string | undefined => (e as BmCallError | null)?.code;
