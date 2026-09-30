import type { MethodName, MethodParams, MethodResult } from '@bm/shared';

export interface BmCallError extends Error {
  code?: string;
  details?: unknown;
}

/** Rejects with an Error that keeps Core's `code` and `details` (window.bm.call would lose them on contextBridge). */
export async function call<K extends MethodName>(method: K, params: MethodParams<K>): Promise<MethodResult<K>> {
  const r = await window.bm.settle(method, params);
  if (r.ok) return r.result;
  throw Object.assign(new Error(r.error.message), { code: r.error.code, details: r.error.details }) as BmCallError;
}

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
export const errorCode = (e: unknown): string | undefined => (e as BmCallError | null)?.code;
