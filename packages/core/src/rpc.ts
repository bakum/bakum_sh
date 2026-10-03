import {
  BmError,
  methods,
  subscriptionTopics,
  toErrorShape,
  type ClientMessage,
  type MethodName,
  type MethodParamsParsed,
  type MethodResult,
  type ServerMessage,
  type Topic,
} from '@bm/shared';
import type { z } from 'zod';
import type { PortLike } from './util/port';
import { log } from './util/logger';
import { t } from './i18n';

export type Handler<K extends MethodName> = (params: MethodParamsParsed<K>) => Promise<MethodResult<K>> | MethodResult<K>;
export type Handlers = { [K in MethodName]?: Handler<K> };

export type TopicHandler<T extends Topic> = (
  params: z.output<(typeof subscriptionTopics)[T]>,
  emit: (data: unknown) => void,
) => () => void;
export type TopicHandlers = { [T in Topic]?: TopicHandler<T> };

/** Dispatches validated requests from any connected port (renderer, main). */
export class RpcServer {
  private handlers: Handlers = {};
  private topics: TopicHandlers = {};

  register(h: Handlers): void {
    Object.assign(this.handlers, h);
  }

  registerTopics(t: TopicHandlers): void {
    Object.assign(this.topics, t);
  }

  /** Calls a method in-process (used by main-originated actions such as tray menu). */
  async call<K extends MethodName>(method: K, params: unknown): Promise<MethodResult<K>> {
    const def = methods[method];
    const handler = this.handlers[method] as Handler<K> | undefined;
    if (!def || !handler) throw new BmError('NO_METHOD', t('rpc.notImplemented', { method }));
    const parsed = def.params.parse(params ?? {}) as MethodParamsParsed<K>;
    return handler(parsed);
  }

  attach(port: PortLike, name: string): void {
    const subs = new Map<number, () => void>();
    const send = (msg: ServerMessage): void => {
      try {
        port.postMessage(msg);
      } catch (err) {
        log().warn({ err, name }, 'post to closed port');
      }
    };
    port.onMessage(async (raw) => {
      const msg = raw as ClientMessage;
      if (!msg || typeof msg !== 'object') return;
      if (msg.kind === 'req') {
        try {
          if (!(msg.method in methods)) throw new BmError('NO_METHOD', t('rpc.unknownMethod', { method: msg.method }));
          const result = await this.call(msg.method as MethodName, msg.params);
          send({ kind: 'res', id: msg.id, ok: true, result });
        } catch (err) {
          const shape = toErrorShape(err);
          if (shape.code === 'INTERNAL') log().error({ err, method: msg.method }, 'rpc handler failed');
          send({ kind: 'res', id: msg.id, ok: false, error: shape });
        }
      } else if (msg.kind === 'sub') {
        const topic = msg.topic as Topic;
        const schema = subscriptionTopics[topic];
        const th = this.topics[topic] as TopicHandler<Topic> | undefined;
        if (!schema || !th) {
          send({ kind: 'res', id: msg.id, ok: false, error: { code: 'NO_TOPIC', message: t('rpc.noTopic', { topic: msg.topic }) } });
          return;
        }
        try {
          const params = schema.parse(msg.params ?? {});
          const unsub = th(params as never, (data) => send({ kind: 'event', subId: msg.id, data }));
          subs.set(msg.id, unsub);
          send({ kind: 'res', id: msg.id, ok: true, result: null });
        } catch (err) {
          send({ kind: 'res', id: msg.id, ok: false, error: toErrorShape(err) });
        }
      } else if (msg.kind === 'unsub') {
        subs.get(msg.id)?.();
        subs.delete(msg.id);
      }
    });
    port.onClose(() => {
      for (const u of subs.values()) u();
      subs.clear();
    });
  }
}
