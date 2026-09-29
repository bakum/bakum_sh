// D55: a build container gets anonymous volumes for the image's VOLUMEs (/var/lib/odoo of the Odoo image). After a
// recreate (a new build of the branch, «Применить») compose passes them on by name and `down -v` no longer removes
// them; dropping the build must still leave no volume behind.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launch, bm } from './pw.mjs';
import { ensureSandbox, waitJob, waitJobs, branch, lastBuild } from './sandbox.mjs';

const ID = 'vols';
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const dangling = () => new Set(docker('volume', 'ls', '-q', '-f', 'dangling=true').split('\n').filter(Boolean));
const containerOf = (buildId) =>
  docker('ps', '-a', '--filter', `label=bm.build=${buildId}`, '--filter', 'label=com.docker.compose.oneoff=False', '--format', '{{.Names}}').split('\n')[0];
const odooVolume = (name) => docker('inspect', name, '--format', '{{range .Mounts}}{{if eq .Destination "/var/lib/odoo"}}{{.Name}}{{end}}{{end}}');

const before = dangling();
const { app, win } = await launch();
let volume = '';
try {
  await ensureSandbox(win, {
    id: ID,
    postgres: 'managed',
    stages: { development: { database: 'fresh', install: { list: ['base'] }, withDemo: false } },
  });
  await waitJobs(win, ID, 900000);
  const br = await branch(win, ID, 'demz-roman');

  // 1. Two builds in a row: the second recreates the container of the same compose project.
  for (const n of [1, 2]) {
    const j = await waitJob(win, (await bm(win, 'builds.rebuild', { branchId: br.id })).jobId);
    check(`сборка ${n}`, j.status === 'success', j.error ?? '');
  }
  const b = await lastBuild(win, br.id);
  const cname = containerOf(b.id);
  volume = odooVolume(cname);
  check('у контейнера анонимный том /var/lib/odoo', !!volume && docker('volume', 'inspect', volume, '--format', '{{json .Labels}}').includes('com.docker.volume.anonymous'), volume.slice(0, 12));
  check('после пересоздания том передан по имени', docker('inspect', cname, '--format', '{{json .HostConfig.Mounts}}').includes(volume));
  check('промежуточных томов не осталось', [...dangling()].filter((v) => !before.has(v)).length === 0);

  // 2. Drop of the live build.
  const dj = await waitJob(win, (await bm(win, 'builds.drop', { buildId: b.id })).jobId);
  check('сборка отброшена', dj.status === 'success', dj.error ?? '');
  const log = (await bm(win, 'jobs.log', { jobId: dj.id })).lines?.join('\n') ?? '';
  check('в логе удаление тома', log.includes(`docker volume rm ${volume.slice(0, 12)}`), log.split('\n').filter((l) => l.includes('volume') || l.includes('том')).join(' | '));
  check('том удалён', !docker('volume', 'ls', '-q').split('\n').includes(volume));
} finally {
  if ((await bm(win, 'projects.list')).some((p) => p.id === ID)) {
    const j = await waitJob(win, (await bm(win, 'projects.delete', { projectId: ID, confirm: ID })).jobId);
    console.log('песочница удалена:', j.status);
  }
  const left = [...dangling()].filter((v) => !before.has(v));
  check('после удаления проекта новых осиротевших томов нет', left.length === 0, left.map((v) => v.slice(0, 12)).join(', '));
  await app.close();
  // The sandbox profile rewrote the shared bm-traefik with its own networks: the default profile's compose is put back.
  const own = path.join(process.env.LOCALAPPDATA, 'Odoo Branch Manager', 'traefik', 'compose.yml');
  if (fs.existsSync(own)) docker('compose', '-p', 'bm-traefik', '-f', own, 'up', '-d');
}
console.log(`Итого: ${results.filter(Boolean).length} из ${results.length}`);
