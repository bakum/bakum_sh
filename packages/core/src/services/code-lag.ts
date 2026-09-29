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

/**
 * Code lag of a branch that copies another build's database (D47): a copy of the production mirror carries modules
 * upgraded by the production code. When the branch lacks some of those commits, a build from the copy runs older
 * module code on that database (`-u` downgrades them), which fails or leaves a half-broken database. The lag is
 * computed in git (the app's mirror, or the user's folder) and cached per commit pair.
 */

/** Commits and modules of `srcSha` missing in `head`; null when a commit is unknown to the repository. */
export async function computeCodeLag(
  repo: string,
  srcSha: string,
  head: string,
  roots: string[],
): Promise<{ behind: number; ahead: number; modules: string[] } | null> {
  if (!(await git.revParse(repo, srcSha)) || !(await git.revParse(repo, head))) return null;
  const behind = await git.countBetween(repo, head, srcSha);
  const ahead = await git.countBetween(repo, srcSha, head);
  if (!behind) return { behind, ahead, modules: [] };
  const base = await git.mergeBase(repo, srcSha, head);
  if (!base) return { behind, ahead, modules: [] };
  const files = await git.diffNames(repo, base, srcSha);
  const ch = changedModules(files, modulesFromTree(await git.lsTree(repo, srcSha)), modulesFromTree(await git.lsTree(repo, base)), roots);
  return { behind, ahead, modules: ch.changed.map((m) => m.name).sort() };
}

const cache = new Map<string, CodeLag | null>();
const pending = new Set<string>();

/** «коммит / коммита / коммитов» */
export function commits(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? 'коммит' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'коммита' : 'коммитов';
  return `${n} ${w}`;
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

/** Text of the lag badge (branch page, sidebar tooltip, Rebuild confirmation). */
export function codeLagText(lag: CodeLag): string {
  const db = lag.production ? 'зеркала прода' : `сборки ветки ${lag.source}`;
  const list = `${lag.modules.slice(0, 8).join(', ')}${lag.modules.length > 8 ? ` и ещё ${lag.modules.length - 8}` : ''}`;
  const mods = lag.modules.length ? ` В ветке старее, чем в этой БД: ${list}.` : '';
  if (!lag.ahead) {
    return (
      `Ветка целиком есть в ${lag.source} и отстаёт от неё на ${commits(lag.behind)} — этим кодом уже обновлена БД ${db}.${mods} ` +
      `Ветку можно удалить или перемотать на ${lag.source}; Rebuild из копии запустит старый код на более новой БД.`
    );
  }
  return (
    `Ветка отстаёт от ${lag.source} на ${commits(lag.behind)} — этим кодом уже обновлена БД ${db}.${mods} ` +
    `Rebuild из копии откатит эти модули старым кодом и может упасть. Сначала подтяните ${lag.source} в ветку (merge или rebase) и сделайте push, затем Rebuild.`
  );
}

/** Badge kinds a lag produces (they replace «Зеркало прода новее вашей БД»). */
export const lagBadge = (lag: CodeLag): BranchView['badges'][number] => ({ kind: lag.ahead ? 'behind-source' : 'merged-behind', text: codeLagText(lag) });
