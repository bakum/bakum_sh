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
import { audit } from './services/audit';
import { startCliServer } from './cli/server';

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
        // Renamed from «DEMZ Branch Manager» (docs/decisions.md D28): build log paths follow the moved data folder.
        if (!dataDir.includes('DEMZ Branch Manager')) {
          sqlite
            .prepare("UPDATE builds SET log_path = REPLACE(log_path, 'DEMZ Branch Manager', 'Odoo Branch Manager') WHERE log_path LIKE '%DEMZ Branch Manager%'")
            .run();
        }
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
          cli: msg.cli,
        };
        setCtx(ctx);
        recordVersion(ctx);
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
        log().info({ pid: process.pid, version: msg.appVersion, dataDir, configDir: msg.configDir }, 'core started');
        void startRuntime(ctx);
        if (ctx.cli) startCliServer(ctx, ctx.cli.pipe);
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

/** Remembers the running version; a change is written to the audit log (base for future data migrations). */
function recordVersion(ctx: Ctx): void {
  const row = ctx.sqlite.prepare("SELECT value FROM kv WHERE key = 'app.version'").get() as { value: string } | undefined;
  const semver = (v: string | undefined) => v?.split('+')[0];
  if (semver(row?.value) === semver(ctx.appVersion)) return;
  ctx.sqlite.prepare("INSERT OR REPLACE INTO kv(key, value) VALUES ('app.version', ?)").run(ctx.appVersion);
  audit(ctx, { action: row ? 'app.upgraded' : 'app.installed', target: ctx.appVersion, params: { from: row?.value ?? null } });
  log().info({ from: row?.value ?? null, to: ctx.appVersion }, 'app version changed');
}
