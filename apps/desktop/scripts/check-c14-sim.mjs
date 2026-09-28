// Criterion 14, simulated without stopping Docker Desktop (that would stop odoo19 / odoo19-db — forbidden by rule 2):
// the app talks to Docker through a named pipe that first does not exist (engine "down"), then a proxy to the real
// engine appears (engine "up"). Expected: banner «Docker Desktop не запущен» with «Запустить», then recovery without
// restarting the app (status, Traefik, reconciliation).
import net from 'node:net';
import { launch, shot, bm } from './pw.mjs';

const PIPE = '\\\\.\\pipe\\bm_sim_docker';
const REAL = '\\\\.\\pipe\\docker_engine';

const { app, win } = await launch({ BM_DOCKER_PIPE: PIPE.replace(/\\/g, '/') });
await win.evaluate(() => (location.hash = '#/status'));
await win.waitForSelector('text=Docker Desktop не запущен', { timeout: 30000 });
const down = await bm(win, 'system.status', {});
console.log('engine down → banner shown; status.docker:', JSON.stringify(down.docker));
await shot(win, 'c14-docker-down');

const server = net.createServer((client) => {
  const upstream = net.connect(REAL);
  client.pipe(upstream).pipe(client);
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
});
await new Promise((r) => server.listen(PIPE, r));
const t0 = Date.now();
await win.waitForSelector('text=Docker Desktop не запущен', { state: 'detached', timeout: 60000 });
console.log(`engine up → banner gone after ${Math.round((Date.now() - t0) / 1000)} s, no app restart`);
await win.waitForTimeout(4000);
const up = await bm(win, 'system.status', { refresh: true });
console.log('status.docker:', JSON.stringify(up.docker), '| traefik:', JSON.stringify(up.traefik), '| discrepancies:', up.discrepancies.length);
await shot(win, 'c14-docker-up');
await app.close();
server.close();
