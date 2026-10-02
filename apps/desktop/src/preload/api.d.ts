import type { MethodName, MethodParams, MethodResult, Topic, UpdateState } from '@bm/shared';

export type CoreStatus = { state: 'connected' | 'restarted' | 'disconnected'; at: string };

export interface BmDesktop {
  selectDirectory(title?: string): Promise<string | null>;
  selectFile(opts?: { title?: string; extensions?: string[] }): Promise<string | null>;
  saveFile(opts: { defaultPath: string; content: string }): Promise<string | null>;
  /** «Сохранить как» without writing: the chosen path, or null. */
  selectSavePath(opts: { title?: string; defaultPath: string; extensions?: string[] }): Promise<string | null>;
  copy(text: string): Promise<boolean>;
  openExternal(url: string): Promise<boolean>;
  confirm(opts: { message: string; detail?: string; buttons?: string[] }): Promise<number>;
  info(): Promise<{ version: string; commit: string; buildDate: string; profile: string; corePid: number | null; sleepBlocked: boolean; windowVisible: boolean; configDir: string; localDir: string }>;
  quit(): Promise<void>;
  onNavigate(cb: (route: string) => void): () => void;
  pathForFile(file: File): string;
  update: {
    get(): Promise<UpdateState | null>;
    check(): Promise<UpdateState | null>;
    install(): Promise<{ ok: boolean; message?: string }>;
    skip(): Promise<UpdateState | null>;
    onState(cb: (s: UpdateState) => void): () => void;
  };
}

/** Outcome of a call as plain data: contextBridge copies only `message` of a rejected Error, not `code` / `details`. */
export type CallOutcome<R> = { ok: true; result: R } | { ok: false; error: { message: string; code?: string; details?: unknown } };

export interface BmApi {
  call<K extends MethodName>(method: K, params: MethodParams<K>): Promise<MethodResult<K>>;
  /** Same call, never rejects: the renderer rebuilds the error with its code and details (lib/bm.ts). */
  settle<K extends MethodName>(method: K, params: MethodParams<K>): Promise<CallOutcome<MethodResult<K>>>;
  subscribe(topic: Topic, params: Record<string, unknown>, handler: (data: unknown) => void): () => void;
  onCoreStatus(cb: (s: CoreStatus) => void): () => void;
  desktop: BmDesktop;
  /** Host OS (`process.platform`): macOS gets its own texts and settings (D67). */
  platform: string;
}

declare global {
  interface Window {
    bm: BmApi;
  }
}
