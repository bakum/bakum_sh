// Criterion 7: two builds open at the same time in one browser keep their logins. Each build has its own host and
// Odoo's session cookie is host-only (no Domain attribute), so a browser keeps one session per host.
// Checked with interleaved authenticated requests to both builds.
import { launch, bm } from './pw.mjs';
import { ensureSandbox, branch } from './sandbox.mjs';
import { odooLogin, odooRpc } from './odoo-http.mjs';

const { app, win } = await launch();
const pid = await ensureSandbox(win);
const names = process.argv.slice(2).length ? process.argv.slice(2) : ['19.0', '19.0-demz-crm'];
const sessions = [];
for (const n of names) {
  const b = await branch(win, pid, n);
  const cred = await bm(win, 'builds.credentials', { buildId: b.liveBuild.id });
  const s = await odooLogin(b.url, cred.login, cred.password);
  const sc = s.setCookie.find((c) => c.startsWith('session_id=')) ?? '';
  console.log(`${n} (${b.url}): login ${cred.login} → ${s.status}; Set-Cookie: ${sc.replace(/session_id=[^;]+/, 'session_id=…')}`);
  sessions.push({ n, url: b.url, cookie: s.session, hostOnly: !/domain=/i.test(sc) });
}
for (let round = 1; round <= 2; round++) {
  for (const s of sessions) {
    const j = await odooRpc(s.url, '/web/session/get_session_info', s.cookie);
    console.log(`round ${round} ${s.n}: uid=${j.result?.uid} db=${j.result?.db} host-only cookie=${s.hostOnly}`);
  }
}
await app.close();
