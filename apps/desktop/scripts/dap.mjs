// Minimal Debug Adapter Protocol client: does what VS Code does with the copied launch.json
// (attach to debugpy, pathMappings, a breakpoint) so criterion 8 can be checked without a GUI.
import net from 'node:net';

export class Dap {
  constructor(port) {
    this.port = port;
    this.seq = 1;
    this.buf = Buffer.alloc(0);
    this.waiters = new Map();
    this.events = [];
    this.eventWaiters = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.sock = net.connect(this.port, '127.0.0.1', resolve);
      this.sock.on('error', reject);
      this.sock.on('data', (d) => this.onData(d));
    });
  }

  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const h = this.buf.indexOf('\r\n\r\n');
      if (h < 0) return;
      const len = Number(/Content-Length: (\d+)/i.exec(this.buf.subarray(0, h).toString())[1]);
      if (this.buf.length < h + 4 + len) return;
      const msg = JSON.parse(this.buf.subarray(h + 4, h + 4 + len).toString('utf8'));
      this.buf = this.buf.subarray(h + 4 + len);
      if (msg.type === 'response') this.waiters.get(msg.request_seq)?.(msg);
      else if (msg.type === 'event') {
        this.events.push(msg);
        for (const w of [...this.eventWaiters]) if (w.name === msg.event) {
          this.eventWaiters.splice(this.eventWaiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    }
  }

  send(command, args = {}) {
    const seq = this.seq++;
    const body = JSON.stringify({ seq, type: 'request', command, arguments: args });
    this.sock.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    return new Promise((resolve) => this.waiters.set(seq, resolve));
  }

  waitEvent(name, timeoutMs = 60000) {
    const seen = this.events.find((e) => e.event === name);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${name}`)), timeoutMs);
      this.eventWaiters.push({ name, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  }

  close() {
    this.sock?.destroy();
  }
}
