// Versioning of Odoo Branch Manager (docs/decisions.md D27, README «Версии»).
//
//   node scripts/version.mjs check                 all package.json files carry the same version, CHANGELOG has it
//   node scripts/version.mjs info                  version, commit, dirty flag
//   node scripts/version.mjs release <patch|minor|major|X.Y.Z> [--no-git]
//        bumps the version everywhere, turns «## [Unreleased]» of CHANGELOG.md into «## [X.Y.Z] — date»,
//        commits «Release vX.Y.Z» and creates the annotated tag vX.Y.Z. Never pushes.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = ['package.json', 'apps/desktop/package.json', 'packages/core/package.json', 'packages/shared/package.json'];
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const fail = (msg) => {
  console.error(`version: ${msg}`);
  process.exit(1);
};

function current() {
  const v = readJson('package.json').version;
  if (!SEMVER.test(v)) fail(`root package.json has an invalid version «${v}»`);
  return v;
}

function next(v, kind) {
  if (SEMVER.test(kind)) return kind;
  const [, maj, min, pat, pre] = SEMVER.exec(v).map((x, i) => (i > 0 && i < 4 ? Number(x) : x));
  switch (kind) {
    case 'major':
      return `${maj + 1}.0.0`;
    case 'minor':
      return `${maj}.${min + 1}.0`;
    case 'patch':
      return pre ? `${maj}.${min}.${pat}` : `${maj}.${min}.${pat + 1}`;
    default:
      fail(`unknown bump «${kind}»: use patch | minor | major | X.Y.Z`);
  }
}

function check() {
  const v = current();
  const bad = PACKAGES.filter((f) => readJson(f).version !== v);
  if (bad.length) fail(`version ${v} differs in: ${bad.join(', ')}`);
  const log = fs.readFileSync(CHANGELOG, 'utf8');
  if (!log.includes(`## [${v}]`)) fail(`CHANGELOG.md has no «## [${v}]» section`);
  console.log(`version ${v}: consistent`);
}

function info() {
  const v = current();
  let commit = 'unknown';
  let dirty = false;
  try {
    commit = git('rev-parse', '--short', 'HEAD');
    dirty = git('status', '--porcelain').length > 0;
  } catch {
    /* not a git checkout */
  }
  console.log(JSON.stringify({ version: v, commit, dirty }));
}

function release(kind, noGit) {
  if (!kind) fail('release needs patch | minor | major | X.Y.Z');
  if (!noGit && git('status', '--porcelain')) fail('the working tree is not clean: commit the changes first');
  const from = current();
  const to = next(from, kind);
  if (to === from) fail(`version is already ${to}`);
  if (!noGit && git('tag', '--list', `v${to}`)) fail(`tag v${to} already exists`);
  for (const f of PACKAGES) {
    const file = path.join(ROOT, f);
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, text.replace(/"version":\s*"[^"]+"/, `"version": "${to}"`));
  }
  const log = fs.readFileSync(CHANGELOG, 'utf8');
  if (!/## \[Unreleased\]/.test(log)) fail('CHANGELOG.md has no «## [Unreleased]» section');
  const date = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(CHANGELOG, log.replace('## [Unreleased]', `## [Unreleased]\n\n## [${to}] — ${date}`));
  console.log(`${from} → ${to}`);
  if (noGit) return;
  git('add', ...PACKAGES, 'CHANGELOG.md');
  git('commit', '-q', '-m', `Release v${to}`);
  git('tag', '-a', `v${to}`, '-m', `Odoo Branch Manager v${to}`);
  console.log(`committed and tagged v${to} (not pushed)`);
}

const [cmd, arg, ...rest] = process.argv.slice(2);
if (cmd === 'check') check();
else if (cmd === 'info') info();
else if (cmd === 'release') release(arg, rest.includes('--no-git'));
else fail('usage: version.mjs check | info | release <patch|minor|major|X.Y.Z> [--no-git]');
