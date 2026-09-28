import type { Level } from '@bm/shared';

export interface LevelValue {
  level: Level;
  value: Record<string, unknown> | undefined | null;
}

export interface MergeResult<T> {
  value: T;
  /** Leaf path → level that set the effective value. */
  sources: Record<string, Level>;
}

/** Fields whose value is a union of shapes: replaced as a whole, never merged key by key. */
export const ATOMIC_PATHS = new Set(['database', 'install', 'updateModules', 'tests.mode']);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Merges settings levels top-down (spec 9.1): objects merge by keys, arrays and scalars are replaced,
 * paths in `atomic` are replaced as a whole. Returns the value and, for each leaf, the level it came from.
 * Pure: inputs are not mutated.
 */
export function mergeLevels<T = Record<string, unknown>>(levels: LevelValue[], atomic: Set<string> = ATOMIC_PATHS): MergeResult<T> {
  let value: Record<string, unknown> = {};
  const sources: Record<string, Level> = {};
  for (const { level, value: layer } of levels) {
    if (!layer) continue;
    value = mergeInto(value, layer, '', level, sources, atomic);
  }
  return { value: value as T, sources };
}

function mergeInto(
  base: Record<string, unknown>,
  layer: Record<string, unknown>,
  prefix: string,
  level: Level,
  sources: Record<string, Level>,
  atomic: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, v] of Object.entries(layer)) {
    if (v === undefined) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const prev = out[key];
    if (isPlainObject(v) && !atomic.has(path)) {
      out[key] = mergeInto(isPlainObject(prev) ? prev : {}, v, path, level, sources, atomic);
      if (Object.keys(v).length === 0 && !isPlainObject(prev)) sources[path] = level;
    } else {
      clearSources(sources, path);
      out[key] = structuredClone(v);
      sources[path] = level;
    }
  }
  return out;
}

function clearSources(sources: Record<string, Level>, path: string): void {
  for (const k of Object.keys(sources)) if (k === path || k.startsWith(`${path}.`)) delete sources[k];
}

/** Source level for a path: exact leaf, else nearest ancestor recorded (atomic values), else undefined. */
export function sourceOf(sources: Record<string, Level>, path: string): Level | undefined {
  if (sources[path]) return sources[path];
  const parts = path.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    const p = parts.slice(0, i).join('.');
    if (sources[p]) return sources[p];
  }
  return undefined;
}

/** Deletes a path from an overrides object ("Сбросить"), pruning empty parents. */
export function unsetPath(obj: Record<string, unknown>, path: string): Record<string, unknown> {
  const copy = structuredClone(obj);
  const parts = path.split('.');
  const stack: Record<string, unknown>[] = [copy];
  let cur: Record<string, unknown> = copy;
  for (const p of parts.slice(0, -1)) {
    const next = cur[p];
    if (!isPlainObject(next)) return copy;
    cur = next;
    stack.push(cur);
  }
  delete cur[parts[parts.length - 1]!];
  for (let i = parts.length - 2; i >= 0; i--) {
    const parent = stack[i]!;
    const child = parent[parts[i]!];
    if (isPlainObject(child) && Object.keys(child).length === 0) delete parent[parts[i]!];
  }
  return copy;
}
