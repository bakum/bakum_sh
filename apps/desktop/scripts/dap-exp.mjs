// Experiment: which pathMappings / source path forms debugpy accepts from a Windows client.
import { Dap } from './dap.mjs';

const port = Number(process.argv[2] ?? 5703);
const local = 'E:/bakum_sh/tmp/sandbox/worktrees/bmdev/test999';
const file = '/demzua/accounting/demz_nbu_currency_rate/bm_ping.py';
const bs = (s) => s.replace(/\//g, '\\');
const variants = [
  { root: local, path: local + file },
  { root: bs(local), path: bs(local + file) },
  { root: local, path: bs(local + file) },
  { root: bs(local.replace('E:', 'e:')), path: bs((local + file).replace('E:', 'e:')) },
];
for (const v of variants) {
  const d = new Dap(port);
  await d.connect();
  await d.send('initialize', { adapterID: 'debugpy', clientID: 'vscode', pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true });
  const a = d.send('attach', {
    name: 'x',
    type: 'debugpy',
    request: 'attach',
    connect: { host: '127.0.0.1', port },
    pathMappings: [{ localRoot: v.root, remoteRoot: '/mnt/repositories/demz-odoo' }],
    clientOS: 'windows',
    justMyCode: false,
  });
  await d.waitEvent('initialized', 20000);
  const bp = await d.send('setBreakpoints', { source: { path: v.path }, breakpoints: [{ line: 7 }] });
  console.log(JSON.stringify(v), '→', JSON.stringify(bp.body.breakpoints[0]));
  await d.send('configurationDone');
  await a;
  await d.send('disconnect', { terminateDebuggee: false });
  d.close();
  await new Promise((r) => setTimeout(r, 1500));
}
