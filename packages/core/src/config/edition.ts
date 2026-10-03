import fs from 'node:fs';
import path from 'node:path';
import type { OdooEdition, ProjectConfig } from '@bm/shared';
import { t } from '../i18n';

const hasWebEnterprise = (dir: string): boolean => {
  try {
    return fs.existsSync(path.join(dir, 'web_enterprise', '__manifest__.py'));
  } catch {
    return false;
  }
};

/**
 * Odoo edition of a project's builds, from its settings: `runtime.enterprise` (the app installs web_enterprise into
 * fresh databases, D32) or a mount whose host folder holds the Enterprise addons (web_enterprise), as in DEMZ.
 * An image with Enterprise baked in cannot be told apart from Community here.
 */
export function odooEdition(cfg: ProjectConfig): OdooEdition {
  const r = cfg.runtime;
  if (r.enterprise) {
    const m = r.mounts.find((x) => x.container === r.enterprise);
    return { kind: 'enterprise', source: m?.host ?? null, note: t('edition.enterprise', { dir: r.enterprise }) };
  }
  const m = r.mounts.find((x) => hasWebEnterprise(x.host));
  if (m) {
    return {
      kind: 'enterprise',
      source: m.host,
      note: t('edition.mounted', { dir: m.container }),
    };
  }
  return { kind: 'community', source: null, note: t('edition.community') };
}
