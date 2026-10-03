/**
 * Client of the app's command line `bm` (D53). Runs as plain Node: the app's own exe with ELECTRON_RUN_AS_NODE=1,
 * started by bin/bm.cmd or bin/bm, which main writes on every start. Only Node built-ins here — the file is copied
 * next to the launchers and must work on its own. All commands are parsed and executed by Core behind the named pipe
 * (a unix socket on macOS, D67).
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

// The client's own messages (Core translates the rest); main writes the language next to cli.js (D69).
const TEXTS = {
  noPipe: {
    uk: 'BM_PIPE не задано: запускайте bm.cmd або bm з папки bin застосунку',
    ru: 'BM_PIPE не задан: запускайте bm.cmd или bm из папки bin приложения',
    en: 'BM_PIPE is not set: run bm.cmd or bm from the app’s bin folder',
  },
  notRunning: {
    uk: 'Odoo Branch Manager не запущено: запустіть застосунок і повторіть команду',
    ru: 'Odoo Branch Manager не запущен: запустите приложение и повторите команду',
    en: 'Odoo Branch Manager is not running: start the app and run the command again',
  },
  noLink: { uk: 'Немає зв’язку з Odoo Branch Manager: ', ru: 'Нет связи с Odoo Branch Manager: ', en: 'No connection to Odoo Branch Manager: ' },
};
const lang = ((): 'uk' | 'ru' | 'en' => {
  try {
    const l = fs.readFileSync(path.join(path.dirname(process.argv[1] ?? ''), 'lang'), 'utf8').trim();
    return l === 'ru' || l === 'en' ? l : 'uk';
  } catch {
    return 'uk';
  }
})();

const pipe = process.env.BM_PIPE;
if (!pipe) {
  process.stderr.write(`${TEXTS.noPipe[lang]}\n`);
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
    // ECONNREFUSED: the socket file of a Core that has exited (macOS).
    err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
      ? `${TEXTS.notRunning[lang]}\n`
      : `${TEXTS.noLink[lang]}${err.message}\n`,
  );
  code = 2;
});
sock.on('close', () => {
  process.exitCode = code ?? 1;
});
