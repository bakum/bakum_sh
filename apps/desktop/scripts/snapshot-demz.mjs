// Criterion 16 evidence: manifest of E:\demz-odoo-19 (path, size, mtime) and of the protected containers.
// Usage: node snapshot-demz.mjs save <file> | node snapshot-demz.mjs diff <before> <after>
// Excluded by design: worktrees/ and data/filestore/o19_br_* (created by the app), data/db (the Postgres cluster
// itself, which the app shares with odoo19-db), .git internals of the repository (fetch / worktree are allowed).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = 'E:/demz-odoo-19';
const EXCLUDE = [/^worktrees(\/|$)/, /^data\/filestore\/o19_br_/, /^data\/db(\/|$)/, /^repositories\/demz-odoo\/\.git(\/|$)/, /(^|\/)__pycache__(\/|$)/];

function walk(dir, rel, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (EXCLUDE.some((x) => x.test(r))) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, r, out);
    else if (e.isFile()) {
      const st = fs.statSync(p);
      out[r] = `${st.size}:${Math.round(st.mtimeMs)}`;
    }
  }
}

function containers() {
  const out = {};
  for (const n of ['odoo19', 'odoo19-db']) {
    out[n] = execFileSync('docker', ['inspect', n, '--format', '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.State.Status}}'], { encoding: 'utf8' }).trim();
  }
  return out;
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'save') {
  const files = {};
  walk(ROOT, '', files);
  fs.writeFileSync(a, JSON.stringify({ at: new Date().toISOString(), containers: containers(), files }, null, 0));
  console.log(`saved ${Object.keys(files).length} files to ${a}`);
} else if (cmd === 'diff') {
  const x = JSON.parse(fs.readFileSync(a, 'utf8'));
  const y = JSON.parse(fs.readFileSync(b, 'utf8'));
  const changed = [];
  for (const k of new Set([...Object.keys(x.files), ...Object.keys(y.files)])) {
    if (x.files[k] !== y.files[k]) changed.push(`${x.files[k] ? (y.files[k] ? 'M' : 'D') : 'A'} ${k}`);
  }
  console.log(`before ${x.at}, after ${y.at}`);
  console.log('containers before:', JSON.stringify(x.containers));
  console.log('containers after: ', JSON.stringify(y.containers));
  console.log(changed.length ? changed.join('\n') : 'no file changes');
}
