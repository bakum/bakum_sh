// Update check against the real GitHub releases of bakum/bakum_sh (no override).
import { launch } from './pw.mjs';
const { app, win } = await launch();
const s = await win.evaluate(() => window.bm.desktop.update.check());
console.log(JSON.stringify({ status: s.status, current: s.current, latest: s.latest, url: s.url, mode: s.mode, error: s.error }));
await app.close();
