/**
 * Saved presets and project export / import (spec 8.1, 9.4; D73). A file either wraps settings as a preset
 * (`preset:` + `config:`) or is a plain project YAML; both are laid over the wizard's detected proposal.
 */
import type { PresetId } from './types';

/** Never leave the machine: the Postgres password and the Connect admin password. */
export const SECRET_PATHS: string[][] = [
  ['postgres', 'password'],
  ['connect', 'adminPassword'],
];

/** Paths and names of this machine: folders, mounts, the Docker network, the Postgres address and containers. */
export const MACHINE_PATHS: string[][] = [
  ['repo', 'mirrorDir'],
  ['repo', 'localFolder'],
  ['repo', 'path'],
  ['repo', 'worktreesDir'],
  ['runtime', 'network'],
  ['runtime', 'mounts'],
  ['runtime', 'filestore', 'hostDir'],
  ['runtime', 'build'],
  ['runtime', 'composeTemplate'],
  ['runtime', 'debug', 'pathMappings'],
  ['production', 'backups', 'dir'],
  ['postgres', 'host'],
  ['postgres', 'port'],
  ['postgres', 'protectedContainers'],
  ['agents', 'skillsDir'],
];

/** What makes a project this project: a preset leaves it to the repository chosen in the wizard. */
export const IDENTITY_PATHS: string[][] = [
  ['id'],
  ['name'],
  ['enabled'],
  ['repo', 'url'],
  ['repo', 'github'],
  ['repo', 'issueUrl'],
  ['repo', 'protectedBranches'],
  ['repo', 'moduleRoots'],
  ['repo', 'modulesToInstall'],
  ['naming', 'db'],
  ['naming', 'host'],
  ['naming', 'branch', 'base'],
  ['naming', 'pr', 'targets'],
  ['production', 'branch'],
];

/** A preset saved in `<settings>/presets` (presets.list). */
export interface PresetInfo {
  /** File name inside the presets folder. */
  file: string;
  name: string;
  base: PresetId;
  /** Project it was saved from. */
  from: string | null;
  savedAt: string | null;
}

/** Settings to lay over the wizard proposal (presets.read). Secrets are already removed. */
export interface PresetOverlay {
  kind: 'preset' | 'project';
  name: string;
  /** Built-in preset whose detected values fill what the file leaves out. */
  base: PresetId;
  config: Record<string, unknown>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** `over` laid over `base`: maps merge key by key, everything else (lists included) is replaced. */
export function overlayConfig<T>(base: T, over: unknown): T {
  if (!isObj(base) || !isObj(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? overlayConfig(base[k], v) : v;
  return out as T;
}
