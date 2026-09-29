# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Odoo Branch Manager — a Windows desktop app (Electron) that acts as a local odoo.sh: git branches of an Odoo modules
repository are laid out into Production / Staging / Development stages, and each branch gets an isolated build
(Odoo container + own database + own worktree) served through a shared Traefik at `http://<slug>.localhost[:8080]`.

Sources of truth, all in Russian:
- `branch-manager-spec.md` — the spec (ТЗ). Section numbers (e.g. «spec 8.3», «9.1») are referenced from code comments.
- `docs/decisions.md` — every design decision and deviation from the spec as `## Dnn` (context / decision /
  alternative). Code comments cite them (`D30`, `D35`). Add a new `Dnn` entry for any non-trivial design choice.
- `implementation-prompt.md` — original engineering and safety rules (summarised below).
- `CHANGELOG.md` — Keep a Changelog; describe user-visible changes under `## [Unreleased]`.

## Commands

```bash
pnpm install          # postinstall rebuilds better-sqlite3 for Electron
pnpm dev              # electron-vite with HMR
pnpm build            # main / preload / renderer → apps/desktop/out
pnpm start            # run the built app
pnpm typecheck        # version check + tsc strict in every package
pnpm test             # Vitest for packages/core, run inside Electron's Node (ELECTRON_RUN_AS_NODE=1, native ABI)
pnpm --filter @bm/core test test/safety.test.ts   # one test file
pnpm --filter @bm/core test -t "part of a test name"
pnpm package          # NSIS installer + portable exe → apps/desktop/dist
pnpm release patch    # bump all package.json, turn [Unreleased] into [X.Y.Z] — date, commit «Release vX.Y.Z», tag; never pushes
```

A GitHub release (tag `vX.Y.Z`, assets `Odoo-Branch-Manager-Setup-X.Y.Z.exe` and `…-Portable-X.Y.Z.exe`) is what
installed copies auto-update from; the updater checks size and SHA-256 of the asset.

There is no linter; `pnpm typecheck` and `pnpm test` are the gates.

`BM_PROFILE=dev` gives separate settings/registry/log folders (suffix ` (dev)`) — use it for anything that runs the app
against real Docker.

### Manual checks against the real app

`apps/desktop/scripts/check-*.mjs` and `accept-*.mjs` drive the built app with Playwright (`pw.mjs`: `launch()`,
`bm(win, method, params)` calls RPC through `window.bm`, `shot()` saves to `tmp/shots/`). Run `pnpm build` first, then
`node apps/desktop/scripts/check-<name>.mjs` from `apps/desktop`. `sandbox.mjs` → `ensureSandbox()` creates a sandbox
project from the DEMZ preset (DB prefix `o19_bmdev_`, hosts `{slug}.dev.localhost`, origin `tmp/sandbox/origin.git`);
scripts delete it in `finally`. The dev profile rewrites the shared `bm-traefik` container with only its own networks;
recent scripts restore the default profile's `%LOCALAPPDATA%\Odoo Branch Manager\traefik\compose.yml` at the end — do
the same in new ones.

## Architecture

pnpm monorepo, TypeScript strict, ESM:
- `apps/desktop` — Electron. `src/main` (window, tray, notifications, updater, spawns Core), `src/preload`
  (`window.bm`), `src/renderer/src` (React, Mantine, TanStack Query, Monaco, xterm.js; pages under `pages/`).
- `packages/core` — all business logic, runs in an Electron `utilityProcess`. Must not import `electron`; desktop
  effects go to main as messages (`ctx.toMain`).
- `packages/shared` — zod schemas of the project/app YAML (`config.ts`), the IPC contract (`ipc.ts`), view types
  (`types.ts`), errors.

**No HTTP port.** Renderer ↔ Core talk over a MessagePort. The contract is `methods` in `packages/shared/src/ipc.ts`
(`'area.name': m<Result>()(zodParams)`); Core validates params and dispatches (`core/src/rpc.ts`); handlers are wired in
`core/src/handlers.ts` (some areas register their own, e.g. `services/build-actions.ts`). The renderer uses
`useBm(method, params)` / `useBmMutation(method)` from `renderer/src/lib/query.ts`; any successful mutation invalidates
all queries. Push updates: `bus.emit({ type: '…changed' })` in Core → `events` topic → renderer refetch. New RPC method =
schema in `ipc.ts` + handler registration + UI call.

**Settings.** YAML files in `%APPDATA%\Odoo Branch Manager\` (`app.yaml`, `projects/<id>.yaml`), loaded and watched by
`core/src/config/store.ts`; hand edits are picked up live. Programmatic changes patch the YAML document
(`YAML.parseDocument` + `setIn`, see `setEnabled` in `services/projects.ts`) to keep comments, then call
`onProjectConfigChanged`. Branch settings merge levels app → project → stage → rule → branch
(`config/effective.ts`, `resolveBranchScope`). New projects come from `detect.ts` (inspects the user's Docker/Odoo
stack, read-only) + presets in `config/presets.ts` (`odoo`, `generic`, `demz`). Changing a schema `.default()` changes
existing YAMLs that omit the field — avoid it. The Postgres password never reaches the renderer (masked `********`).

**Registry.** SQLite via Drizzle in `%LOCALAPPDATA%\Odoo Branch Manager\registry.sqlite` (`core/src/db/`): projects,
branches, builds, jobs, snapshots, audit_log, kv. Schema migrations are an append-only `MIGRATIONS` array tracked by
`PRAGMA user_version`.

**Jobs.** Everything slow is a persistent job (`core/src/jobs/queue.ts`): one active job per branch, `HEAVY` types
limited by `limits.maxParallelBuilds`, `EXCLUSIVE` types run alone within their project. Executors are registered in
`core/src/boot.ts`; each job logs to `logs/jobs/<id>-<type>.log` (shown in the UI via `jobs.log`). After a Core restart
unfinished jobs become `interrupted`. New job type = `JobType` in `shared/src/types.ts` + `queue.register` in `boot.ts`.

**Builds.** `core/src/builds/pipeline.ts` runs `BUILD_STEPS` (code → port → database → filestore → local-tweaks →
modules → tests → up → finalize); every step must be idempotent and retryable from any step. One live build per
branch, older ones become `dropped`. Each build is a compose project `bm-<project>-<slug>` generated by
`docker/compose.ts` (pure, snapshot-tested) with `bm.*` ownership labels and Traefik labels; the live compose file is
`<dataDir>/projects/<id>/branches/<slug>/compose.yml`. Code comes from the app's bare mirror (`repos/<name>.git`) as
detached worktrees; Odoo CLI one-offs go through `docker compose run` (`builds/odoo-cli.ts`).

**Postgres.** `postgres.mode: external` — the user's container (e.g. `odoo19-db` on `localhost:5433`); `managed` — the
app's own `bm-<project>-db` in network `bm-<project>` (`docker/postgres.ts`). `ensurePostgres()` runs before start /
restart / apply / modules / builds (starts a stopped external container). `services/pg-migrate.ts` moves a project from
external to managed. New projects are created managed (D36).

**Assistant skill (D52).** `core/src/agents/skill.ts` renders the SKILL.md the app installs into the user's
`.claude/skills/` (Settings → «Ассистенты», `services/agents.ts`); it tells assistants how to use builds via the
`bm.*` container labels. When builds, labels or the Tools tab change behaviour, update this text and its snapshot.

**Command line bm (D53).** Core serves a named pipe (`core/src/cli`: `commands.ts` parses and runs, `server.ts`
listens); main writes `<localDir>/bin/{bm.cmd,bm,cli.js}` on every start (`src/main/cli-install.ts`, client
`src/main/cli.ts` — Node built-ins only). Commands enqueue jobs and stream their log; protected branches are refused.

**Runtime / reconcile.** `core/src/runtime.ts` fires `onStart` / `onDockerUp` hooks (Traefik, managed Postgres,
reconcile). `reconcile.ts` compares registry vs Docker labels, worktrees and databases and only reports discrepancies
and orphans (Status page); nothing is deleted without the user.

## Safety rules (hard constraints)

- Every destructive call (drop DB, remove container/compose project/worktree/filestore/mirror) goes through
  `assertOwned()` in `core/src/safety.ts`: the resource must match the project's templates/labels/location AND be in
  the registry AND not be in `protectedDbs` / `protectedContainers`.
- Never stop, recreate or modify `odoo19`, `odoo19-db`, or the databases `o19_test`, `postgres` except through an
  explicit user action. Don't create or change files in `E:\demz-odoo-19` other than what the app itself creates
  (`worktrees\`, `data\filestore\o19_br_*`). Don't touch `E:\bakum_sh\build\` (unrelated 1C config, gitignored).
- In the user's `demz-odoo` repository: no push, no branch switching in the main checkout.
- Don't read `.env` files. Postgres credentials come from `docker inspect` of the Odoo container or its `odoo.conf`.
- External commands only via `execa` / `dockerCli` with argument arrays, never shell strings. SQL identifiers only from
  templates validated by `SQL_IDENT_RE` (`^[a-z0-9_]+$`).
- Manual testing uses the sandbox project, not the real DEMZ project.

## Conventions

- UI text, user-facing error messages (`BmError` with a clear next step), README/CHANGELOG/decisions are in Russian;
  code, comments and commit messages in English (commit messages explain why).
- Line endings are mixed (many files are CRLF, `CHANGELOG.md` has both); preserve each file's existing endings when
  editing.
- Windows host: Docker Desktop via the named pipe; in Git Bash run `docker exec` with container paths under
  `MSYS_NO_PATHCONV=1`. A terminal launched from VS Code may carry `ELECTRON_RUN_AS_NODE=1`; the app scripts clear it.
- `apps/desktop/tsconfig.json` only references `tsconfig.node.json` / `tsconfig.web.json` for the editor; the
  build-time constants `__BM_VERSION__`, `__BM_COMMIT__`, `__BM_BUILD_DATE__` are declared in `src/build-info.d.ts`.
