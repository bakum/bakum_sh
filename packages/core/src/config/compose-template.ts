import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { BmError, type ProjectConfig } from '@bm/shared';
import { t } from '../i18n';

/** Parsed `runtime.composeTemplate` (D72): a compose fragment the generated compose.yml is merged with. */
export interface ComposeTemplate {
  services: Record<string, Record<string, unknown>>;
  volumes: Record<string, unknown>;
  networks: Record<string, unknown>;
}

const TOP_KEYS = new Set(['services', 'volumes', 'networks']);
/** Fixed by the app: a fixed name would clash between builds, the project name is the ownership boundary. */
const FORBIDDEN_SERVICE_KEYS = ['container_name'];

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Validates the parsed YAML of a template; `file` is only for the messages. */
export function parseComposeTemplate(text: string, file: string): ComposeTemplate {
  let doc: unknown;
  try {
    // Merge keys (`<<: *common`) as compose itself resolves them.
    doc = YAML.parse(text, { merge: true }) ?? {};
  } catch (err) {
    throw new BmError('COMPOSE_TEMPLATE_INVALID', t('ctpl.yaml', { file, error: (err as Error).message }));
  }
  if (!isMap(doc)) throw new BmError('COMPOSE_TEMPLATE_INVALID', t('ctpl.notMap', { file }));
  for (const k of Object.keys(doc)) {
    // x-* are compose extension fields (YAML anchors live there); they need no merging.
    if (!TOP_KEYS.has(k) && !k.startsWith('x-')) throw new BmError('COMPOSE_TEMPLATE_INVALID', t('ctpl.topKey', { file, key: k }));
  }
  const services = doc.services ?? {};
  if (!isMap(services)) throw new BmError('COMPOSE_TEMPLATE_INVALID', t('ctpl.notMap', { file }));
  for (const [name, svc] of Object.entries(services)) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new BmError('COMPOSE_TEMPLATE_INVALID', t('ctpl.serviceName', { file, name }));
    if (!isMap(svc)) throw new BmError('COMPOSE_TEMPLATE_INVALID', t('ctpl.serviceMap', { file, name }));
    for (const k of FORBIDDEN_SERVICE_KEYS) if (k in svc) throw new BmError('COMPOSE_TEMPLATE_INVALID', t('ctpl.forbidden', { file, name, key: k }));
  }
  const volumes = doc.volumes ?? {};
  const networks = doc.networks ?? {};
  if (!isMap(volumes) || !isMap(networks)) throw new BmError('COMPOSE_TEMPLATE_INVALID', t('ctpl.notMap', { file }));
  return { services: services as ComposeTemplate['services'], volumes, networks };
}

/** Reads `runtime.composeTemplate` of the project; null when it is not set. */
export function readComposeTemplate(cfg: ProjectConfig): ComposeTemplate | null {
  const file = cfg.runtime.composeTemplate?.trim();
  if (!file) return null;
  if (!path.isAbsolute(file)) throw new BmError('COMPOSE_TEMPLATE_INVALID', t('ctpl.relative', { file }));
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new BmError('COMPOSE_TEMPLATE_MISSING', t('ctpl.missing', { file }));
  }
  return parseComposeTemplate(text, file);
}

/** Hash of the template file for configHash: editing it marks live builds «конфигурация изменилась». */
export function composeTemplateHash(cfg: ProjectConfig): string | null {
  const file = cfg.runtime.composeTemplate?.trim();
  if (!file) return null;
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
  } catch {
    return 'missing';
  }
}
