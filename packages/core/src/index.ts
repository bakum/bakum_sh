import path from 'node:path';
import type { MainToCore } from '@bm/shared';
import { RpcServer } from './rpc';
import { bus } from './events';
import type { CoreHost, PortLike } from './util/port';
import { initLogger, log } from './util/logger';
import { nowIso } from './util/time';
import { ConfigStore } from './config/store';
import { openDb } from './db';
import { setCtx, type Ctx } from './context';
import { registerHandlers } from './handlers';
import { configChangeHooks, onProjectConfigChanged, syncProjectRows } from './services/projects';
import { startRuntime, stopRuntime, handleHook } from './runtime';
import { bootServices } from './boot';

export type { CoreHost, PortLike } from './util/port';

/** Entry point of the Core utility process. */
export function startCore(host: CoreHost): void {
  const rpc = new RpcServer();
  const startedAt = nowIso();
  let ctx: Ctx | null = null;
  const pendingPorts: PortLike[] = [];

  rpc.registerTopics({
    events: (_p, emit) => bus.on((batch) => emit(batch)),
  });

  process.on('uncaughtException', (err) => {
    log().fatal({ err }, 'uncaught exception');
  });
  process.on('unhandledRejection', (err) => {
    log().error({ err }, 'unhandled rejection');
  });

  host.onMainMessage((msg: MainToCore, ports) => {
    switch (msg.kind) {
      case 'init': {
        const store = new ConfigStore(msg.configDir);
        store.load();
        const dataDir = store.dataDir(msg.dataDirOverride);
        const logsDir = path.join(dataDir, 'logs');
        initLogger(logsDir);
        const { db, sqlite } = openDb(path.join(dataDir, 'registry.sqlite'));
        ctx = {
          store,
          db,
          sqlite,
          rpc,
          dataDir,
          logsDir,
          configDir: msg.configDir,
          appVersion: msg.appVersion,
          toMain: (m) => host.postToMain(m),
          startedAt,
          proxyPort: null,
        };
        setCtx(ctx);
        syncProjectRows(ctx);
        registerHandlers(ctx);
        const services = bootServices(ctx);
        configChangeHooks.push(services.onConfigChanged);
        store.watch(({ app, projectIds }) => {
          if (!ctx) return;
          if (app) ctx.toMain({ kind: 'appConfig', config: ctx.store.app });
          for (const id of projectIds) {
            const cfg = ctx.store.get(id)?.config;
            if (cfg) onProjectConfigChanged(ctx, null, cfg);
            else bus.emit({ type: 'project.changed', projectId: id });
          }
          bus.emit({ type: 'config.changed' });
        });
        host.postToMain({ kind: 'appConfig', config: store.app });
        for (const p of pendingPorts.splice(0)) rpc.attach(p, 'client');
        host.postToMain({ kind: 'ready', pid: process.pid });
        log().info({ pid: process.pid, dataDir, configDir: msg.configDir }, 'core started');
        void startRuntime(ctx);
        break;
      }
      case 'renderer-port': {
        const port = ports[0];
        if (!port) return;
        if (ctx) rpc.attach(port, 'client');
        else pendingPorts.push(port);
        break;
      }
      case 'hook':
        if (ctx) void handleHook(ctx, msg.argv);
        break;
      case 'shutdown':
        void (async () => {
          if (ctx) await stopRuntime(ctx, msg.cancelJobs);
          process.exit(0);
        })();
        break;
    }
  });
}
