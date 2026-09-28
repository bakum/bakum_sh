/**
 * Sandboxed preload: owns the MessagePort to Core and exposes a typed, minimal `window.bm`.
 * The renderer never sees the port, Node or Electron objects.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { ClientMessage, ServerMessage, UpdateState } from '@bm/shared';
import type { BmApi, CoreStatus } from './api';

let port: MessagePort | null = null;
let nextId = 1;
const queue: ClientMessage[] = [];
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
const subs = new Map<number, { topic: string; params: unknown; handler: (d: unknown) => void }>();
const statusListeners = new Set<(s: CoreStatus) => void>();
const navListeners = new Set<(r: string) => void>();

function send(msg: ClientMessage): void {
  if (port) port.postMessage(msg);
  else queue.push(msg);
}

function emitStatus(s: CoreStatus): void {
  for (const l of statusListeners) l(s);
}

ipcRenderer.on('bm:port', (e) => {
  const next = e.ports[0];
  if (!next) return;
  const reconnect = port !== null;
  port?.close();
  port = next;
  port.onmessage = (ev: MessageEvent<ServerMessage>) => {
    const msg = ev.data;
    if (msg.kind === 'res') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code, details: msg.error.details }));
    } else if (msg.kind === 'event') {
      subs.get(msg.subId)?.handler(msg.data);
    }
  };
  port.start();
  if (reconnect) {
    for (const p of pending.values()) p.reject(Object.assign(new Error('Core был перезапущен, повторите действие'), { code: 'CORE_RESTARTED' }));
    pending.clear();
    queue.length = 0;
    // Re-establish live subscriptions on the new Core.
    for (const [id, s] of subs) port.postMessage({ kind: 'sub', id, topic: s.topic, params: s.params } satisfies ClientMessage);
  }
  for (const m of queue.splice(0)) port.postMessage(m);
  emitStatus({ state: 'connected', at: new Date().toISOString() });
});

ipcRenderer.on('bm:core-status', (_e, s: CoreStatus) => emitStatus(s));
ipcRenderer.on('bm:navigate', (_e, route: string) => {
  for (const l of navListeners) l(route);
});

const api: BmApi = {
  call(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      send({ kind: 'req', id, method, params });
    });
  },
  subscribe(topic, params, handler) {
    const id = nextId++;
    subs.set(id, { topic, params, handler });
    send({ kind: 'sub', id, topic, params });
    return () => {
      subs.delete(id);
      send({ kind: 'unsub', id });
    };
  },
  onCoreStatus(cb) {
    statusListeners.add(cb);
    return () => statusListeners.delete(cb);
  },
  desktop: {
    selectDirectory: (title) => ipcRenderer.invoke('bm:selectDirectory', title),
    selectFile: (opts) => ipcRenderer.invoke('bm:selectFile', opts),
    saveFile: (opts) => ipcRenderer.invoke('bm:saveFile', opts),
    copy: (text) => ipcRenderer.invoke('bm:copy', text),
    openExternal: (url) => ipcRenderer.invoke('bm:openExternal', url),
    confirm: (opts) => ipcRenderer.invoke('bm:confirm', opts),
    info: () => ipcRenderer.invoke('bm:info'),
    quit: () => ipcRenderer.invoke('bm:quit'),
    onNavigate(cb) {
      navListeners.add(cb);
      return () => navListeners.delete(cb);
    },
    pathForFile: (file) => webUtils.getPathForFile(file),
    update: {
      get: () => ipcRenderer.invoke('bm:update:get'),
      check: () => ipcRenderer.invoke('bm:update:check'),
      install: () => ipcRenderer.invoke('bm:update:install'),
      skip: () => ipcRenderer.invoke('bm:update:skip'),
      onState(cb) {
        const h = (_e: unknown, s: UpdateState) => cb(s);
        ipcRenderer.on('bm:update-state', h);
        return () => ipcRenderer.off('bm:update-state', h);
      },
    },
  },
};

contextBridge.exposeInMainWorld('bm', api);
