/** Minimal message-port abstraction so Core does not depend on Electron types. */
export interface PortLike {
  postMessage(data: unknown): void;
  onMessage(cb: (data: unknown) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

/** What the hosting process (Electron main via utilityProcess) provides to Core. */
export interface CoreHost {
  postToMain(msg: import('@bm/shared').CoreToMain): void;
  onMainMessage(cb: (msg: import('@bm/shared').MainToCore, ports: PortLike[]) => void): void;
}
