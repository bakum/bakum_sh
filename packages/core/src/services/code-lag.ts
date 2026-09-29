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

/** «коммита / коммитов» after «нет»: 1 коммита, 2 коммитов (genitive). */
function missingCommits(n: number): string {
  return `${n} ${one(n) ? 'коммита' : 'коммитов'}`;
}

/** 1, 21, 101… agree with a singular word. */
const one = (n: number): boolean => n % 10 === 1 && n % 100 !== 11;

/**
 * Text of the lag badge (branch page, sidebar tooltip, Rebuild confirmation): what happened, whether Rebuild is safe,
 * what to do — three lines. Rebuild is only risky when the missing commits change modules: those get `-u` with the
 * branch's older code on a database already upgraded by the newer one.
 */
export function codeLagText(lag: CodeLag): string {
  const db = lag.production ? 'зеркала прода' : `сборки ветки ${lag.source}`;
  const src = lag.source;
  const list = `${lag.modules.slice(0, 8).join(', ')}${lag.modules.length > 8 ? ` и ещё ${lag.modules.length - 8}` : ''}`;
  // «которым», «недостающий коммит» only for exactly one: «21 коммита, которыми».
  const single = lag.behind === 1;
  const what = lag.ahead
    ? `В ветке нет ${missingCommits(lag.behind)} из ${src}, ${single ? 'которым' : 'которыми'} уже обновлена БД ${db}, откуда ветка берёт копию базы.`
    : `Ветка целиком влита в ${src} и отстала от неё на ${commits(lag.behind)}; своих коммитов в ней нет.`;
  const risk = lag.modules.length
    ? `Rebuild рискован: ${single ? 'недостающий коммит меняет' : 'недостающие коммиты меняют'} модули ${list}. Rebuild обновит их в свежей копии базы кодом ветки — более ` +
      'старым, чем в базе: сборка может упасть (тогда останется текущая) или база окажется полусломанной. Код ветки Rebuild не меняет.'
    : `Rebuild безопасен: ${single ? 'недостающий коммит не меняет' : 'недостающие коммиты не меняют'} модули. Код ветки Rebuild не меняет, база сборки заменяется свежей копией.`;
  const todo = lag.ahead
    ? `Что сделать: влейте ${src} в ветку — git fetch, git merge origin/${src}, git push, затем Rebuild. Rebase не нужен: он ` +
      'переписывает историю ветки и требует push --force.'
    : `Что сделать: ветка не нужна — удалите её (Delete). Нужна — перемотайте на ${src} (fast-forward, история не ` +
      `переписывается): git fetch, git merge --ff-only origin/${src}, git push, затем Rebuild.`;
  return `${what}\n${risk}\n${todo}`;
}

/** Badge kinds a lag produces (they replace «Зеркало прода новее вашей БД»). */
export const lagBadge = (lag: CodeLag): BranchView['badges'][number] => ({ kind: lag.ahead ? 'behind-source' : 'merged-behind', text: codeLagText(lag) });
