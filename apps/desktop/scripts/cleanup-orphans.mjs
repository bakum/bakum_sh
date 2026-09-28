import { launch, bm } from './pw.mjs';
const { app, win } = await launch({ BM_PROFILE: '' });
const st = await bm(win, 'system.status', { refresh: true });
console.log('orphans:', JSON.stringify(st.orphans));
const r = await bm(win, 'system.cleanupOrphans', { items: st.orphans });
console.log('removed:', r.removed, 'errors:', JSON.stringify(r.errors));
console.log('orphans now:', JSON.stringify((await bm(win, 'system.status', { refresh: true })).orphans));
await app.close();
