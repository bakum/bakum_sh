import type { NotificationKind } from '@bm/shared';
import type { Ctx } from '../context';
import { bus } from '../events';

/** Windows notification through main (spec 7); each type can be switched off in app.yaml. */
export function notify(ctx: Ctx, kind: NotificationKind, title: string, body: string, opts: { route?: string; url?: string } = {}): void {
  bus.emit({ type: 'notification', message: `${title}: ${body}` });
  if (!ctx.store.app.desktop.notifications[kind]) return;
  ctx.toMain({ kind: 'notify', notifType: kind, title, body, route: opts.route, url: opts.url });
}
