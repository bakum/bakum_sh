import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '@bm/shared';

/** Dockerfile of `runtime.build`: a relative path is resolved against the build context (D46). */
export const dockerfilePath = (b: { context: string; dockerfile: string }): string => path.resolve(b.context, b.dockerfile);

/** Hash of the Dockerfile for configHash: editing it marks live builds «конфигурация изменилась». */
export function dockerfileHash(cfg: ProjectConfig): string | null {
  const b = cfg.runtime.build;
  if (!b) return null;
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(dockerfilePath(b))).digest('hex').slice(0, 12);
  } catch {
    return 'missing';
  }
}
