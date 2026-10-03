import type { BranchView, CodeLag, ProjectConfig, ResolvedBranchScope } from '@bm/shared';
import type { Ctx } from '../context';
import type { BranchRow } from '../db/schema';
import * as git from '../git';
import { codeSource } from '../git/worktrees';
import { changedModules, modulesFromTree } from '../modules';
import { liveBuild } from '../builds/view';
import { branchByName } from './branch-rows';
import { bus } from '../events';
import { log } from '../util/logger';
import { t } from '../i18n';

/**
 * Code lag of a branch that copies another build's database (D47): a copy of the production mirror carries modules
 * upgraded by the production code. When the branch lacks some of those commits, a build from the copy runs older
 * module code on that database (`-u` downgrades them), which fails or leaves a half-broken database. The lag is
 * computed in git (the app's mirror, or the user's folder) and cached per commit pair.
 */

/**
 * Commits and modules of `srcSha` missing in `head`; null when a commit is unknown to the repository. A branch whose
 * code is identical to the source (its PR merged with a merge commit, the branch not fast-forwarded) is not behind:
 * the missing commits bring no code.
 */
export async function computeCodeLag(
  repo: string,
  srcSha: string,
  head: string,
  roots: string[],
): Promise<{ behind: number; ahead: number; modules: string[] } | null> {
  if (!(await git.revParse(repo, srcSha)) || !(await git.revParse(repo, head))) return null;
  let behind = await git.countBetween(repo, head, srcSha);
  const ahead = await git.countBetween(repo, srcSha, head);
  if (behind && (await git.sameTree(repo, head, srcSha))) behind = 0;
  if (!behind) return { behind, ahead, modules: [] };
  const base = await git.mergeBase(repo, srcSha, head);
  if (!base) return { behind, ahead, modules: [] };
  const files = await git.diffNames(repo, base, srcSha);
  const ch = changedModules(files, modulesFromTree(await git.lsTree(repo, srcSha)), modulesFromTree(await git.lsTree(repo, base)), roots);
  return { behind, ahead, modules: ch.changed.map((m) => m.name).sort() };
}

const cache = new Map<string, CodeLag | null>();
const pending = new Set<string>();

/** «1 commit / 2 commits» in the interface language (D69). */
export function commits(n: number): string {
  return t('lag.commits', { n });
}

/**
 * Lag of a Development branch whose database is a copy (`database: copy:*`) behind the code of its source build.
 * Synchronous: a cache miss starts the computation and returns null; the branch is re-emitted when it is ready.
 */
export function codeLagOf(ctx: Ctx, cfg: ProjectConfig, b: BranchRow, scope: ResolvedBranchScope): CodeLag | null {
  if (b.stage === 'production' || !scope.database.startsWith('copy:')) return null;
  const srcName = scope.database === 'copy:production' ? cfg.production.branch : scope.database.slice('copy:'.length);
  const srcBranch = branchByName(ctx, cfg.id, srcName);
  const srcLive = srcBranch ? liveBuild(ctx, srcBranch.id) : undefined;
  const from = codeSource(cfg, b, scope);
  const head = from.kind === 'folder' ? (b.lastSeenLocalSha ?? null) : (b.lastSeenRemoteSha ?? null);
  if (!srcLive?.commitSha || !head) return null;
  const key = `${from.repo}|${srcLive.commitSha}|${head}`;
  if (cache.has(key)) return cache.get(key)!;
  if (cache.size > 500) cache.clear();
  if (!pending.has(key)) {
    pending.add(key);
    computeCodeLag(from.repo, srcLive.commitSha, head, cfg.repo.moduleRoots)
      .then((r) => {
        cache.set(key, r && { source: srcName, production: srcName === cfg.production.branch, sourceSha: srcLive.commitSha!, ...r });
        bus.emit({ type: 'branch.changed', projectId: b.projectId, branchId: b.id });
      })
      .catch((err) => {
        log().debug({ err, branch: b.name }, 'code lag failed');
        cache.set(key, null);
      })
      .finally(() => pending.delete(key));
  }
  return null;
}


/**
 * Text of the lag badge (branch page, sidebar tooltip, Rebuild confirmation): what happened, whether Rebuild is safe,
 * what to do — three lines. Rebuild is only risky when the missing commits change modules: those get `-u` with the
 * branch's older code on a database already upgraded by the newer one.
 */
export function codeLagText(lag: CodeLag): string {
  const src = lag.source;
  const db = lag.production ? t('lag.dbProd') : t('lag.dbBranch', { src });
  const list = `${lag.modules.slice(0, 8).join(', ')}${lag.modules.length > 8 ? t('lag.more', { n: lag.modules.length - 8 }) : ''}`;
  // The singular wording only for exactly one: «21 коммита, которыми».
  const single = lag.behind === 1;
  const what = lag.ahead
    ? t(single ? 'lag.whatOne' : 'lag.whatMany', { n: lag.behind, src, db })
    : t('lag.merged', { src, commits: commits(lag.behind) });
  const risk = lag.modules.length ? t(single ? 'lag.riskyOne' : 'lag.riskyMany', { list }) : t(single ? 'lag.safeOne' : 'lag.safeMany');
  const todo = t(lag.ahead ? 'lag.todoMerge' : 'lag.todoFastForward', { src });
  return `${what}\n${risk}\n${todo}`;
}

/** Badge kinds a lag produces (they replace «Зеркало прода новее вашей БД»). */
export const lagBadge = (lag: CodeLag): BranchView['badges'][number] => ({ kind: lag.ahead ? 'behind-source' : 'merged-behind', text: codeLagText(lag) });
