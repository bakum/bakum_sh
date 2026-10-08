import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { BmError } from '@bm/shared';
import { branchDir, type Ctx } from '../context';
import type { BuildRow } from '../db/schema';
import { generateCompose, ODOO_SERVICE } from '../docker/compose';
import { resolveBranchScope } from '../config/effective';
import { readComposeTemplate } from '../config/compose-template';
import { codeSource } from '../git/worktrees';
import { branchRow } from '../services/branch-rows';
import { configHash } from './view';
import { codeVars, serverBaseArgs } from './odoo-cli';
import { t } from '../i18n';

export interface LiveCompose {
  file: string;
  text: string;
  /** configHash of the configuration the text was generated from. */
  hash: string;
}

/** compose.yml of a live build as the current configuration and code would write it (not written). */
export function liveComposeText(ctx: Ctx, b: BuildRow): LiveCompose {
  const br = branchRow(ctx, b.branchId);
  if (!br) throw new BmError('NO_BRANCH', t('exec.branchDeleted'));
  const cfg = ctx.store.require(b.projectId);
  const scope = resolveBranchScope(cfg, br.name, br.stage, br.overrides).scope;
  const code = codeSource(cfg, br, scope).dir;
  if (!code) throw new BmError('NO_WORKTREE', t('exec.noWorktree'));
  const vars = codeVars(cfg, code);
  const proxyPort = ctx.proxyPort ?? ctx.store.app.proxyPort;
  const text = generateCompose({
    cfg,
    scope,
    branch: { id: br.id, name: br.name, slug: br.slug, stage: br.stage },
    build: { id: b.id, number: b.number, dbName: b.dbName, host: b.host, composeProject: b.composeProject, debugPort: b.debugPort },
    worktree: code,
    addonsPath: vars.addonsPath as string | undefined,
    proxyPort,
    odooArgs: serverBaseArgs(cfg, vars),
    template: readComposeTemplate(cfg),
  });
  return { file: path.join(branchDir(ctx, cfg.id, br.slug), 'compose.yml'), text, hash: configHash(cfg, scope, proxyPort) };
}

const odooCommand = (text: string): string => JSON.stringify((YAML.parse(text) as { services?: Record<string, { command?: unknown }> })?.services?.[ODOO_SERVICE]?.command ?? null);

/**
 * D77: the module folders of a build from the user's folder changed since its compose.yml was written (a branch added
 * `demzua/<x>`): the server runs with the old `{addonsPath}` and does not load the new modules. Only with the same
 * configuration — a changed one already asks for «Применить». Any doubt (no file, no modules) is no drift.
 */
export function addonsDrift(ctx: Ctx, b: BuildRow): LiveCompose | null {
  try {
    const br = branchRow(ctx, b.branchId);
    const cfg = ctx.store.require(b.projectId);
    if (!br || !cfg.runtime.command.some((a) => a.includes('{addonsPath}'))) return null;
    if (!resolveBranchScope(cfg, br.name, br.stage, br.overrides).scope.folder) return null;
    const now = liveComposeText(ctx, b);
    if (!fs.existsSync(now.file) || !b.configHash || b.configHash !== now.hash) return null;
    return odooCommand(fs.readFileSync(now.file, 'utf8')) === odooCommand(now.text) ? null : now;
  } catch {
    return null;
  }
}
