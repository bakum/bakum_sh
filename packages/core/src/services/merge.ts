import { BmError } from '@bm/shared';
import type { Ctx } from '../context';
import { mustBranch } from './branches';
import { audit } from './audit';
import { t } from '../i18n';

/**
 * Merge (spec 8.10), stage 1 part: the GitHub compare page for head=<source> → base=<target>.
 * PR creation through gh is postponed (D44). The app never merges or pushes locally.
 */
export function mergeUrl(ctx: Ctx, sourceId: number, targetId: number): { url: string } {
  const s = mustBranch(ctx, sourceId);
  const tgt = mustBranch(ctx, targetId);
  if (s.projectId !== tgt.projectId) throw new BmError('BAD_PARAMS', t('merge.differentProjects'));
  const cfg = ctx.store.require(s.projectId);
  if (!cfg.repo.github) throw new BmError('NO_GITHUB', t('merge.noGithub'));
  const url = `https://github.com/${cfg.repo.github}/compare/${encodeURIComponent(tgt.name)}...${encodeURIComponent(s.name)}?expand=1`;
  audit(ctx, { projectId: cfg.id, action: 'branch.merge', target: `${s.name} → ${tgt.name}`, params: { url } });
  return { url };
}
