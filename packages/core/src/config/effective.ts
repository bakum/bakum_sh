import type { BranchScope, EffectiveField, Level, ProjectConfig, ResolvedBranchScope, Stage } from '@bm/shared';
import { APP_STAGE_DEFAULTS } from './presets';
import { mergeLevels, sourceOf } from './merge';
import { selectStage } from './rules';

export interface ResolvedScope {
  scope: ResolvedBranchScope;
  sources: Record<string, Level>;
  ruleIndex: number | null;
  fields: EffectiveField[];
}

/** Project-level values that feed branch-scope fields (runtime image / env, filestore copy mode). */
export function projectLevelScope(cfg: ProjectConfig): BranchScope {
  return {
    image: cfg.runtime.image,
    env: cfg.runtime.env,
    filestoreCopy: cfg.runtime.filestore.copy,
  };
}

/**
 * Effective settings of one branch: app defaults → project → stage → matching branch rule → branch overrides.
 * The rule is looked up by branch name even if the stage was fixed by the user; its overrides only apply
 * when the rule's stage equals the branch's current stage.
 */
export function resolveBranchScope(cfg: ProjectConfig, branch: string, stage: Stage, branchOverrides: BranchScope | null): ResolvedScope {
  const sel = selectStage(cfg, branch);
  const ruleApplies = sel.rule && sel.stage === stage;
  const merged = mergeLevels<ResolvedBranchScope>([
    { level: 'app', value: APP_STAGE_DEFAULTS[stage] as unknown as Record<string, unknown> },
    { level: 'project', value: projectLevelScope(cfg) as Record<string, unknown> },
    { level: 'stage', value: cfg.stages[stage] as Record<string, unknown> | undefined },
    { level: 'rule', value: ruleApplies ? (sel.rule!.overrides as Record<string, unknown> | undefined) : undefined },
    { level: 'branch', value: branchOverrides as Record<string, unknown> | null },
  ]);
  // `tracking` is a leftover of old YAML (D33); the folder is honoured for Development branches only.
  delete (merged.value as Partial<ResolvedBranchScope> & { tracking?: unknown }).tracking;
  delete merged.sources.tracking;
  if (stage !== 'development' || !merged.value.folder) {
    merged.value.folder = null;
    delete merged.sources.folder;
  }
  const fields = flattenFields(merged.value as unknown as Record<string, unknown>, merged.sources);
  return { scope: merged.value, sources: merged.sources, ruleIndex: ruleApplies ? sel.ruleIndex : null, fields };
}

const LEAF_OBJECTS = new Set(['install', 'updateModules', 'tests.mode', 'env']);

function flattenFields(value: Record<string, unknown>, sources: Record<string, Level>, prefix = ''): EffectiveField[] {
  const out: EffectiveField[] = [];
  for (const [k, v] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && !LEAF_OBJECTS.has(path)) {
      out.push(...flattenFields(v as Record<string, unknown>, sources, path));
    } else {
      out.push({ path, value: v, level: highestSourceUnder(sources, path) ?? sourceOf(sources, path) ?? 'app' });
    }
  }
  return out;
}

/** For whole-object fields (env) the lowest level that touched any of its keys. */
function highestSourceUnder(sources: Record<string, Level>, path: string): Level | undefined {
  const order: Level[] = ['app', 'project', 'stage', 'rule', 'branch'];
  let best: Level | undefined;
  for (const [k, lvl] of Object.entries(sources)) {
    if (k.startsWith(`${path}.`) && (!best || order.indexOf(lvl) > order.indexOf(best))) best = lvl;
  }
  return best;
}
