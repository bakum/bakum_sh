import type { MethodName, MethodParams, MethodResult, Topic, UpdateState } from '@bm/shared';

export type CoreStatus = { state: 'connected' | 'restarted' | 'disconnected'; at: string };

export interface BmDesktop {
  selectDirectory(title?: string): Promise<string | null>;
  selectFile(opts?: { title?: string; extensions?: string[] }): Promise<string | null>;
  saveFile(opts: { defaultPath: string; content: string }): Promise<string | null>;
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

export interface BmApi {
  call<K extends MethodName>(method: K, params: MethodParams<K>): Promise<MethodResult<K>>;
  subscribe(topic: Topic, params: Record<string, unknown>, handler: (data: unknown) => void): () => void;
  onCoreStatus(cb: (s: CoreStatus) => void): () => void;
  desktop: BmDesktop;
}

declare global {
  interface Window {
    bm: BmApi;
  }
}
