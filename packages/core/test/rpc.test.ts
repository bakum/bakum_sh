import { describe, expect, it } from 'vitest';
import { RpcServer } from '../src/rpc';
import type { PortLike } from '../src/util/port';

function pair() {
  const sent: unknown[] = [];
  let handler: (d: unknown) => void = () => {};
  const port: PortLike = {
    postMessage: (d) => sent.push(d),
    onMessage: (cb) => (handler = cb),
    onClose: () => {},
    close: () => {},
  };
  return { port, sent, deliver: (d: unknown) => handler(d) };
}

describe('RpcServer', () => {
  it('answers a valid request', async () => {
    const rpc = new RpcServer();
    rpc.register({ 'system.ping': () => ({ pong: true, pid: 1, startedAt: 'x' }) });
    const p = pair();
    rpc.attach(p.port, 't');
    p.deliver({ kind: 'req', id: 7, method: 'system.ping', params: {} });
    await new Promise((r) => setTimeout(r, 0));
    expect(p.sent).toEqual([{ kind: 'res', id: 7, ok: true, result: { pong: true, pid: 1, startedAt: 'x' } }]);
  });

  it('rejects invalid params with a VALIDATION error', async () => {
    const rpc = new RpcServer();
    rpc.register({ 'branches.list': () => ({}) as never });
    const p = pair();
    rpc.attach(p.port, 't');
    p.deliver({ kind: 'req', id: 1, method: 'branches.list', params: { projectId: 'BAD ID' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(p.sent[0]).toMatchObject({ kind: 'res', id: 1, ok: false, error: { code: 'VALIDATION' } });
  });

  it('rejects unknown methods', async () => {
    const rpc = new RpcServer();
    const p = pair();
    rpc.attach(p.port, 't');
    p.deliver({ kind: 'req', id: 2, method: 'nope.nope', params: {} });
    await new Promise((r) => setTimeout(r, 0));
    expect(p.sent[0]).toMatchObject({ ok: false, error: { code: 'NO_METHOD' } });
  });
});
