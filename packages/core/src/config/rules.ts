import type { BranchMatch, BranchRule, ProjectConfig, Stage } from '@bm/shared';

/** Glob for branch names: `*` matches anything (including `/`), `?` one character. */
export function globToRegex(glob: string): RegExp {
  let re = '';
  for (const ch of glob) {
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function matchesBranch(match: BranchMatch, branch: string): boolean {
  if (typeof match === 'string') return globToRegex(match).test(branch);
  if (Array.isArray(match)) return match.some((m) => globToRegex(m).test(branch));
  return new RegExp(match.regex).test(branch);
}

export interface StageSelection {
  stage: Stage | 'ignore';
  ruleIndex: number | null;
  rule: BranchRule | null;
}

/**
 * Stage for a branch (spec 8.2): the production branch is always Production; otherwise
 * branchRules top-down, first match wins; no match → Development (as odoo.sh does).
 */
export function selectStage(cfg: Pick<ProjectConfig, 'production' | 'branchRules'>, branch: string): StageSelection {
  if (branch === cfg.production.branch) return { stage: 'production', ruleIndex: null, rule: null };
  for (let i = 0; i < cfg.branchRules.length; i++) {
    const rule = cfg.branchRules[i]!;
    if (matchesBranch(rule.match, branch)) return { stage: rule.stage, ruleIndex: i, rule };
  }
  return { stage: 'development', ruleIndex: null, rule: null };
}

/** Whether `autoAddBranches` wants this branch added automatically. `ignore` always wins. */
export function shouldAutoAdd(cfg: Pick<ProjectConfig, 'production' | 'branchRules' | 'autoAddBranches'>, branch: string): StageSelection | null {
  const sel = selectStage(cfg, branch);
  if (sel.stage === 'ignore') return null;
  if (sel.stage === 'production') return sel;
  switch (cfg.autoAddBranches) {
    case 'none':
      return null;
    case 'rules':
      return sel.ruleIndex === null ? null : sel;
    case 'all':
      return sel;
  }
}
