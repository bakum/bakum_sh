import { BmError } from '@bm/shared';
import type { Ctx } from '../context';
import { mustBranch } from './branches';
import { audit } from './audit';

/**
 * Merge (spec 8.10), stage 1 part: the GitHub compare page for head=<source> → base=<target>.
 * PR creation through gh is stage 2. The app never merges or pushes locally.
 */
export function mergeUrl(ctx: Ctx, sourceId: number, targetId: number): { url: string } {
  const s = mustBranch(ctx, sourceId);
  const t = mustBranch(ctx, targetId);
  if (s.projectId !== t.projectId) throw new BmError('BAD_PARAMS', 'Ветки из разных проектов');
  const cfg = ctx.store.require(s.projectId);
  if (!cfg.repo.github) throw new BmError('NO_GITHUB', 'У проекта не указан GitHub-репозиторий (repo.github): открыть сравнение негде.');
  const url = `https://github.com/${cfg.repo.github}/compare/${encodeURIComponent(t.name)}...${encodeURIComponent(s.name)}?expand=1`;
  audit(ctx, { projectId: cfg.id, action: 'branch.merge', target: `${s.name} → ${t.name}`, params: { url } });
  return { url };
}
