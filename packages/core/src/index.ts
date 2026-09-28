import type { MainToCore } from '@bm/shared';
import { RpcServer } from './rpc';
import { bus } from './events';
import type { CoreHost, PortLike } from './util/port';
import { initLogger, log } from './util/logger';
import { nowIso } from './util/time';

export type { CoreHost, PortLike } from './util/port';

/** Entry point of the Core utility process. */
export function startCore(host: CoreHost): void {
  const rpc = new RpcServer();
  const startedAt = nowIso();
  let initialized = false;
  const pendingPorts: PortLike[] = [];

  rpc.register({
    'system.ping': () => ({ pong: true, pid: process.pid, startedAt }),
  });
  rpc.registerTopics({
    events: (_p, emit) => bus.on((batch) => emit(batch)),
  });

  host.onMainMessage((msg: MainToCore, ports) => {
    switch (msg.kind) {
      case 'init': {
        initLogger(msg.dataDirOverride ?? process.cwd());
        initialized = true;
        for (const p of pendingPorts.splice(0)) rpc.attach(p, 'renderer');
        host.postToMain({ kind: 'ready', pid: process.pid });
        log().info({ pid: process.pid }, 'core started');
        break;
      }
      case 'renderer-port': {
        const port = ports[0];
        if (!port) return;
        if (initialized) rpc.attach(port, 'renderer');
        else pendingPorts.push(port);
        break;
      }
      case 'hook':
      case 'shutdown':
        break;
    }
  });
}
