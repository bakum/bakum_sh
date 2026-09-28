import { launch, bm } from './pw.mjs';
const { app, win } = await launch();
for (let i = 0; i < 60; i++) {
  const s = await bm(win, 'system.status', {});
  if (s.traefik.ok || (s.traefik.text && !s.traefik.text.includes('не запущен') && i > 50)) break;
  if (s.traefik.text.includes('Traefik не запущен:')) { console.log(s.traefik.text); break; }
  await new Promise((r) => setTimeout(r, 2000));
}
const s = await bm(win, 'system.status', { refresh: true });
console.log(JSON.stringify({ docker: s.docker, traefik: s.traefik, postgres: s.postgres, disc: s.discrepancies, orphans: s.orphans }, null, 1));
await app.close();
