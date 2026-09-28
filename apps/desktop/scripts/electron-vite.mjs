// Runs electron-vite with a clean environment: shells started from VS Code inherit
// ELECTRON_RUN_AS_NODE=1, which would make Electron start as plain Node.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cli = require.resolve('electron-vite/bin/electron-vite.js');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const res = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit', env });
process.exit(res.status ?? 1);
