import fs from 'node:fs';
import path from 'node:path';

export const LEGACY_PRODUCT = 'DEMZ Branch Manager';

export interface DirsResult {
  configDir: string;
  localDir: string;
  /** What happened, for main.log. */
  notes: string[];
}

/**
 * The app was renamed from «DEMZ Branch Manager» to «Odoo Branch Manager» (docs/decisions.md D28).
 * On the first start after the rename the old folders are moved to the new names, so projects, the registry,
 * compose files and logs of live builds are kept. If the move fails (e.g. the old version is still running
 * and holds files open), the old folders are used as they are — nothing is lost.
 */
export function resolveDirs(appData: string, localAppData: string, product: string, suffix: string): DirsResult {
  const notes: string[] = [];
  const pick = (root: string): string => {
    const next = path.join(root, `${product}${suffix}`);
    const old = path.join(root, `${LEGACY_PRODUCT}${suffix}`);
    if (fs.existsSync(next) || !fs.existsSync(old)) return next;
    try {
      fs.renameSync(old, next);
      notes.push(`moved ${old} → ${next}`);
      return next;
    } catch (err) {
      notes.push(`could not move ${old} (${(err as Error).message}); using it as is`);
      return old;
    }
  };
  // Data first: if it cannot be moved, the configuration stays next to it under the old name too.
  const localDir = pick(localAppData);
  const configDir = localDir.includes(LEGACY_PRODUCT) ? path.join(appData, `${LEGACY_PRODUCT}${suffix}`) : pick(appData);

  // app.yaml may point dataDir at the old default explicitly.
  const appYaml = path.join(configDir, 'app.yaml');
  if (!configDir.includes(LEGACY_PRODUCT) && fs.existsSync(appYaml)) {
    const text = fs.readFileSync(appYaml, 'utf8');
    if (text.includes(LEGACY_PRODUCT)) {
      fs.writeFileSync(appYaml, text.split(LEGACY_PRODUCT).join(product), 'utf8');
      notes.push('app.yaml: dataDir updated to the new name');
    }
  }
  return { configDir, localDir, notes };
}
