/**
 * Client of the app's command line `bm` (D53). Runs as plain Node: the app's own exe with ELECTRON_RUN_AS_NODE=1,
 * started by bin/bm.cmd or bin/bm, which main writes on every start. Only Node built-ins here — the file is copied
 * next to bm.cmd and must work on its own. All commands are parsed and executed by Core behind the named pipe.
 */
import net from 'node:net';

const pipe = process.env.BM_PIPE;
if (!pipe) {
  process.stderr.write('BM_PIPE не задан: запускайте bm.cmd или bm из папки bin приложения\n');
  process.exit(2);
}

let buf = '';
let code: number | null = null;
const sock = net.connect(pipe);
sock.setEncoding('utf8');
sock.on('connect', () => {
  sock.write(`${JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() })}\n`);
});
sock.on('data', (chunk: string) => {
  buf += chunk;
  for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    const m = JSON.parse(line) as { o?: string; e?: string; x?: number };
    if (m.o !== undefined) process.stdout.write(`${m.o}\n`);
    else if (m.e !== undefined) process.stderr.write(`${m.e}\n`);
    else if (m.x !== undefined) code = m.x;
  }
});
sock.on('error', (err: NodeJS.ErrnoException) => {
  process.stderr.write(
    err.code === 'ENOENT'
      ? 'Odoo Branch Manager не запущен: запустите приложение и повторите команду\n'
      : `Нет связи с Odoo Branch Manager: ${err.message}\n`,
  );
  code = 2;
});
sock.on('close', () => {
  process.exitCode = code ?? 1;
});
