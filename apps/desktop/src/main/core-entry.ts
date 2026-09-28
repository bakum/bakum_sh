/**
 * Entry of the Core utility process. The only Electron-aware code of Core:
 * adapts `process.parentPort` / MessagePortMain to the plain interfaces of @bm/core.
 */
import type { MessagePortMain } from 'electron';
import { startCore, type PortLike } from '@bm/core';

function wrap(port: MessagePortMain): PortLike {
  const wrapped: PortLike = {
    postMessage: (data) => port.postMessage(data),
    onMessage: (cb) => {
      port.on('message', (e) => cb(e.data));
      port.start();
    },
    onClose: (cb) => port.on('close', cb),
    close: () => port.close(),
  };
  return wrapped;
}

const parent = process.parentPort;
startCore({
  postToMain: (msg) => parent.postMessage(msg),
  onMainMessage: (cb) => parent.on('message', (e) => cb(e.data, e.ports.map(wrap))),
});
