// Criterion 8: attach to debugpy with the launch.json the app generates (the way VS Code does it: the Python
// extension adds clientOS=windows and sends Windows paths) → a breakpoint in the worktree file is hit;
// Editor opens exactly the worktree.
import { launch, bm } from './pw.mjs';
import { ensureSandbox, branch } from './sandbox.mjs';
import { httpReq } from './odoo-http.mjs';
import { Dap } from './dap.mjs';

const BRANCH = process.argv[2] ?? '19.0-demz-test999';
const REL = process.argv[3] ?? 'demzua/accounting/demz_nbu_currency_rate/bm_ping.py';
const LINE = Number(process.argv[4] ?? 7);
const ROUTE = process.argv[5] ?? '/bm/ping';

const { app, win } = await launch();
const pid = await ensureSandbox(win);
const b = await branch(win, pid, BRANCH);
const lj = JSON.parse((await bm(win, 'builds.launchJson', { buildId: b.liveBuild.id })).json).configurations[0];
console.log('launch.json configuration:', JSON.stringify(lj));
const file = `${lj.pathMappings[0].localRoot}/${REL}`.replace(/\//g, '\\');
const dap = new Dap(lj.connect.port);
await dap.connect();
await dap.send('initialize', { adapterID: 'debugpy', clientID: 'vscode', pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true });
const attach = dap.send('attach', { ...lj, clientOS: 'windows' });
await dap.waitEvent('initialized', 30000);
const bp = await dap.send('setBreakpoints', { source: { path: file }, breakpoints: [{ line: LINE }] });
console.log('breakpoint:', JSON.stringify(bp.body.breakpoints[0]));
await dap.send('configurationDone');
await attach;
const req = httpReq(`${b.url}${ROUTE}`).then((r) => `${r.status} ${r.body.toString().slice(0, 40)}`);
const stopped = await dap.waitEvent('stopped', 60000).catch((e) => ({ error: e.message }));
if (stopped.body) {
  const st = await dap.send('stackTrace', { threadId: stopped.body.threadId, levels: 1 });
  const top = st.body.stackFrames[0];
  console.log(`STOPPED (${stopped.body.reason}) at ${top.source?.path}:${top.line} in ${top.name}`);
  await dap.send('continue', { threadId: stopped.body.threadId });
} else console.log('not stopped:', stopped.error);
console.log('HTTP response after continue:', await req);
await dap.send('disconnect', { terminateDebuggee: false });
dap.close();

const r = await bm(win, 'shell.open', { branchId: b.id, target: 'editor' });
console.log('Editor:', JSON.stringify(r), '→ worktree', b.worktreePath);
await app.close();
