// HTTP helpers for the checks. Browsers resolve *.localhost to 127.0.0.1 themselves; Node's resolver does not,
// so requests go to 127.0.0.1 with the build host in the Host header (what a browser sends).
import http from 'node:http';

export function httpReq(url, { method = 'GET', headers = {}, body } = {}) {
  const u = new URL(url);
  const loop = u.hostname === 'localhost' || u.hostname.endsWith('.localhost');
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: loop ? '127.0.0.1' : u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers: { host: u.host, ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const firstCookie = (h) => (Array.isArray(h) ? h : h ? [h] : []).map((c) => c.split(';')[0]).find((c) => c.startsWith('session_id=')) ?? null;

export async function odooLogin(base, login, password) {
  const r1 = await httpReq(`${base}/web/login`);
  const pre = firstCookie(r1.headers['set-cookie']);
  const csrf = /name="csrf_token" value="([^"]+)"/.exec(r1.body.toString())?.[1] ?? '';
  const body = new URLSearchParams({ csrf_token: csrf, login, password, redirect: '/odoo' }).toString();
  const r2 = await httpReq(`${base}/web/login`, {
    method: 'POST',
    body,
    headers: { cookie: pre ?? '', 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) },
  });
  const setCookie = [].concat(r2.headers['set-cookie'] ?? []);
  return { ok: r2.status === 303 || r2.status === 302, status: r2.status, session: firstCookie(setCookie) ?? pre, setCookie };
}

export async function odooGet(base, path, session) {
  const r = await httpReq(`${base}${path}`, { headers: session ? { cookie: session } : {} });
  return { status: r.status, type: r.headers['content-type'], body: r.body };
}

export async function odooRpc(base, path, session, params = {}) {
  const body = JSON.stringify({ jsonrpc: '2.0', method: 'call', params });
  const r = await httpReq(`${base}${path}`, {
    method: 'POST',
    body,
    headers: { cookie: session ?? '', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
  });
  return JSON.parse(r.body.toString());
}

export async function httpStatus(url) {
  try {
    const r = await httpReq(url);
    return `${r.status}${r.status === 200 ? ' ' + r.body.toString().slice(0, 40) : ''}`;
  } catch (e) {
    return `ERR ${e.code ?? e.message}`;
  }
}
