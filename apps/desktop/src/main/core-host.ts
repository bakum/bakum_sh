import path from 'node:path';
import { EventEmitter } from 'node:events';
import { MessageChannelMain, utilityProcess, type MessagePortMain, type UtilityProcess } from 'electron';
import type { ClientMessage, CoreToMain, MainToCore, MethodName, MethodParams, MethodResult, ServerMessage } from '@bm/shared';
import type { Logger } from 'pino';

export interface CoreHostOptions {
  configDir: string;
  dataDirOverride: string | null;
  appVersion: string;
  resourcesPath: string;
  log: Logger;
}

/**
 * Owns the Core utility process: spawns it, hands out MessagePorts, restarts it when it dies.
 * Emits: 'message' (CoreToMain), 'restarted', 'ready'.
 */
export class CoreHost extends EventEmitter {
  private proc: UtilityProcess | null = null;
  private mainPort: MessagePortMain | null = null;
  private reqId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private restarts: number[] = [];
  private stopping = false;
  private generation = 0;
  pid: number | null = null;

  constructor(private readonly opts: CoreHostOptions) {
    super();
  }

  start(): void {
    this.generation++;
    const entry = path.join(__dirname, 'core.js');
    const proc = utilityProcess.fork(entry, [], {
      serviceName: 'Odoo Branch Manager Core',
      stdio: 'pipe',
      env: { ...process.env },
    });
    this.proc = proc;
    proc.stdout?.on('data', (d: Buffer) => this.opts.log.info({ src: 'core-stdout' }, d.toString().trimEnd()));
    proc.stderr?.on('data', (d: Buffer) => this.opts.log.warn({ src: 'core-stderr' }, d.toString().trimEnd()));

    proc.on('spawn', () => {
      this.pid = proc.pid ?? null;
      this.opts.log.info({ pid: this.pid, generation: this.generation }, 'core spawned');
      this.post({
        kind: 'init',
        configDir: this.opts.configDir,
        dataDirOverride: this.opts.dataDirOverride,
        appVersion: this.opts.appVersion,
        resourcesPath: this.opts.resourcesPath,
      });
      this.connectMainClient();
    });
    proc.on('message', (msg: CoreToMain) => {
      if (msg.kind === 'ready') this.emit('ready', msg.pid);
      this.emit('message', msg);
    });
    proc.on('exit', (code) => {
      this.opts.log.warn({ code, pid: this.pid }, 'core exited');
      this.proc = null;
      this.pid = null;
      for (const p of this.pending.values()) p.reject(new Error('Core перезапускается, повторите действие'));
      this.pending.clear();
      if (this.stopping) {
        this.emit('stopped');
        return;
      }
      const now = Date.now();
      this.restarts = this.restarts.filter((t) => now - t < 60_000);
      this.restarts.push(now);
      const delay = this.restarts.length > 5 ? 10_000 : 500;
      setTimeout(() => {
        if (this.stopping) return;
        this.start();
        this.emit('restarted');
      }, delay);
    });
  }

  private post(msg: MainToCore, ports: MessagePortMain[] = []): void {
    this.proc?.postMessage(msg, ports);
  }

  /** Creates a fresh channel for a renderer; returns the renderer side. */
  createClientPort(): MessagePortMain | null {
    if (!this.proc) return null;
    const { port1, port2 } = new MessageChannelMain();
    this.post({ kind: 'renderer-port' }, [port1]);
    return port2;
  }

  private connectMainClient(): void {
    const port = this.createClientPort();
    if (!port) return;
    this.mainPort?.close();
    this.mainPort = port;
    port.on('message', (e) => {
      const msg = e.data as ServerMessage;
      if (msg.kind !== 'res') return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
    });
    port.start();
  }

  /** Main-originated RPC (tray menu, hooks). */
  call<K extends MethodName>(method: K, params: MethodParams<K>): Promise<MethodResult<K>> {
    const port = this.mainPort;
    if (!port) return Promise.reject(new Error('Core не запущен'));
    const id = ++this.reqId;
    const msg: ClientMessage = { kind: 'req', id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      port.postMessage(msg);
    });
  }

  sendHook(argv: string[]): void {
    this.post({ kind: 'hook', argv });
  }

  /** Graceful stop; resolves when the process is gone (or after a timeout). */
  stop(cancelJobs: boolean): Promise<void> {
    this.stopping = true;
    const proc = this.proc;
    if (!proc) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        proc.kill();
        resolve();
      }, 5000);
      this.once('stopped', () => {
        clearTimeout(t);
        resolve();
      });
      this.post({ kind: 'shutdown', cancelJobs });
    });
  }
}
