import crypto from 'node:crypto';
import http from 'node:http';
import YAML from 'yaml';
import { BmError, type ProjectConfig } from '@bm/shared';
import type { Ctx } from '../context';
import type { BuildRow } from '../db/schema';
import { dockerCli } from '../docker/client';
import { buildUrl } from '../docker/compose';
import { removeTraefikDynamic, writeTraefikDynamic } from '../docker/traefik';
import { serviceContainer } from '../builds/pipeline';
import { codeVars, serverBaseArgs } from '../builds/odoo-cli';
import * as pg from '../pg';
import { runtimeState } from '../state';
import { audit } from './audit';
import { log } from '../util/logger';

/** Internal users of the build's database: active, not portal / public (`share`), as odoo.sh lists them. */
export async function buildUsers(cfg: ProjectConfig, b: BuildRow): Promise<{ id: number; login: string; name: string }[]> {
  try {
    return await pg.query<{ id: number; login: string; name: string }>(
      cfg.postgres,
      b.dbName,
      `SELECT u.id, u.login, COALESCE(p.name, u.login) AS name
         FROM res_users u LEFT JOIN res_partner p ON p.id = u.partner_id
        WHERE u.active AND NOT COALESCE(u.share, false)
        ORDER BY lower(COALESCE(p.name, u.login)), u.id`,
    );
  } catch (err) {
    throw new BmError('DB_FAILED', `Не удалось прочитать пользователей из базы ${b.dbName}: ${(err as Error).message}`);
  }
}

/**
 * Run by `odoo shell` of the build (stdin): a logged-in session for the user, saved where the server keeps its
 * sessions, exactly as a login with the password would leave it. The login comes in the environment.
 */
const SESSION_SCRIPT = `
import os
from odoo import http
login = os.environ['BM_CONNECT_LOGIN']
user = env['res.users'].with_context(active_test=False).search([('login', '=', login)], limit=1)
if not user:
    print('BM_CONNECT_ERROR=no-user', flush=True)
elif not user.active:
    print('BM_CONNECT_ERROR=inactive', flush=True)
else:
    store = http.root.session_store
    s = store.new()
    s.update(getattr(http, 'get_default_session', dict)())
    s.update(db=env.cr.dbname, login=user.login, uid=user.id, context=dict(env['res.users'].with_user(user).context_get()))
    s.session_token = user._compute_session_token(s.sid)
    store.save(s)
    print('BM_CONNECT_SID=' + s.sid, flush=True)
`;

const SID_RE = /^[A-Za-z0-9_-]{16,256}$/;
const HOST_RE = /^[a-z0-9.-]+$/i;
/** One-off route of a connect lives this long; the browser opens it within seconds. */
const ROUTE_TTL_MS = 60_000;

/** One request to Traefik on loopback with the build's Host: the status and Set-Cookie of the connect route. */
function probe(port: number, host: string, urlPath: string): Promise<{ status: number; cookie: boolean }> {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers: { Host: host }, timeout: 3000 }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, cookie: !!res.headers['set-cookie']?.length });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ status: 0, cookie: false }));
    req.end();
  });
}

/**
 * «Войти как» (D66): a session for `login` created by the build's own Odoo, and a one-off Traefik route on the build's
 * host that sets it as the browser's cookie and redirects to /web. The password of the user is neither read nor changed.
 */
export async function connectAs(ctx: Ctx, cfg: ProjectConfig, b: BuildRow, login: string, codeDir: string | null): Promise<{ ok: true }> {
  if (!b.live || b.status !== 'running') throw new BmError('NOT_RUNNING', 'Сборка не запущена: нажмите Start и повторите');
  if (!runtimeState.traefik.ok) throw new BmError('NO_TRAEFIK', runtimeState.traefik.error ?? 'Traefik не запущен: проверьте страницу Status');
  if (!HOST_RE.test(b.host)) throw new BmError('BAD_HOST', `Недопустимый адрес сборки ${b.host}`);
  const c = await serviceContainer(b);
  if (!c) throw new BmError('NOT_RUNNING', 'Контейнер сборки не найден: запустите сборку (Start)');

  const argv = ['exec', '-i', '-e', 'BM_CONNECT_LOGIN', c.name, 'odoo', 'shell', ...serverBaseArgs(cfg, codeVars(cfg, codeDir)), '-d', b.dbName, '--no-http'];
  const r = await dockerCli(argv, { input: SESSION_SCRIPT, env: { BM_CONNECT_LOGIN: login }, timeoutMs: 180_000 });
  const out = `${r.stdout}\n${r.stderr}`;
  const err = /BM_CONNECT_ERROR=(\S+)/.exec(out)?.[1];
  if (err === 'no-user') throw new BmError('NO_USER', `В базе ${b.dbName} нет пользователя с логином «${login}»`);
  if (err === 'inactive') throw new BmError('NO_USER', `Пользователь «${login}» в базе ${b.dbName} архивирован: войти под ним нельзя`);
  const sid = /BM_CONNECT_SID=(\S+)/.exec(out)?.[1];
  if (!sid || !SID_RE.test(sid)) {
    log().warn({ exitCode: r.exitCode, tail: out.trim().split('\n').slice(-15) }, 'connect-as: no session');
    const tail = out.trim().split('\n').slice(-6).join('\n');
    throw new BmError('ODOO_FAILED', `Odoo не создал сессию (odoo shell, код ${r.exitCode}).\n${tail}`);
  }

  const nonce = crypto.randomBytes(16).toString('hex');
  const name = `connect-${nonce}`;
  const urlPath = `/bm/connect/${nonce}`;
  const maxAge = 7 * 24 * 3600;
  const yaml = YAML.stringify({
    http: {
      routers: {
        [name]: {
          rule: `Host(\`${b.host}\`) && Path(\`${urlPath}\`)`,
          priority: 1_000_000,
          entryPoints: ['web'],
          middlewares: [`${name}-cookie`, `${name}-go`],
          service: `${name}-none`,
        },
      },
      middlewares: {
        // Applied to the redirect's own response: the cookie replaces the browser's session on this host.
        [`${name}-cookie`]: {
          headers: { customResponseHeaders: { 'Set-Cookie': `session_id=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`, 'Cache-Control': 'no-store' } },
        },
        [`${name}-go`]: { redirectRegex: { regex: '.*', replacement: '/web' } },
      },
      // Never reached: the redirect answers first.
      services: { [`${name}-none`]: { loadBalancer: { servers: [{ url: 'http://127.0.0.1:1' }] } } },
    },
  });
  // Routes of earlier connects that were not removed (Core restarted within the minute).
  await removeTraefikDynamic({ pattern: 'connect-*.yml', minutes: 2 });
  await writeTraefikDynamic(`${name}.yml`, yaml);
  setTimeout(() => void removeTraefikDynamic({ name: `${name}.yml` }), ROUTE_TTL_MS).unref();

  const port = ctx.proxyPort ?? ctx.store.app.proxyPort;
  const until = Date.now() + 20_000;
  for (;;) {
    const p = await probe(port, b.host, urlPath);
    if (p.status >= 300 && p.status < 400 && p.cookie) break;
    if (Date.now() > until) {
      await removeTraefikDynamic({ name: `${name}.yml` });
      throw new BmError('NO_TRAEFIK', 'Traefik не подхватил маршрут входа за 20 с: перезапустите приложение (оно обновит Traefik) и повторите');
    }
    await new Promise((res) => setTimeout(res, 300));
  }
  audit(ctx, { projectId: b.projectId, action: 'build.connectAs', target: `${b.composeProject}#${b.number}`, params: { login } });
  ctx.toMain({ kind: 'openExternal', url: `${buildUrl(b.host, port)}${urlPath}` });
  return { ok: true };
}
