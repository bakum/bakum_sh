import fs from 'node:fs';
import path from 'node:path';
import { BmError, type ProjectConfig } from '@bm/shared';
import { docker, dockerCli } from './client';
import { pullImage } from './postgres';
import { dockerfilePath } from '../config/dockerfile';

/**
 * `runtime.build` (spec 9.3, D46): the app builds the Odoo image of the project from a Dockerfile and tags it
 * `runtime.image`. The image carries `bm.project=<id>`; a tag that already names an image without that label (e.g. the
 * image of the user's own compose stack) is never overwritten.
 */

/** Refuses a tag that names someone else's image. */
export async function assertOwnTag(cfg: ProjectConfig, tag: string): Promise<void> {
  const info = await docker.getImage(tag).inspect().catch(() => null);
  if (!info) return;
  const owner = info.Config?.Labels?.['bm.project'];
  if (owner !== cfg.id) {
    throw new BmError(
      'IMAGE_NOT_OWNED',
      `Образ ${tag} уже есть и собран не приложением для проекта ${cfg.id}${owner ? ` (bm.project=${owner})` : ''}: приложение его не перезапишет. ` +
        `Укажите в runtime.image своё имя, например bm-${cfg.id}-odoo:latest.`,
    );
  }
}

/** `docker build` of runtime.build → runtime.image (the layer cache makes an unchanged Dockerfile a matter of seconds). */
export async function buildImage(cfg: ProjectConfig, say: (l: string) => void, signal?: AbortSignal): Promise<void> {
  const b = cfg.runtime.build;
  if (!b) throw new BmError('NO_BUILD_CONFIG', 'В настройках проекта не задан runtime.build');
  const context = path.resolve(b.context);
  const file = dockerfilePath(b);
  if (!fs.existsSync(context) || !fs.statSync(context).isDirectory()) throw new BmError('NO_CONTEXT', `Папка сборки образа не найдена: ${context} (runtime.build.context)`);
  if (!fs.existsSync(file)) throw new BmError('NO_DOCKERFILE', `Dockerfile не найден: ${file} (runtime.build.dockerfile)`);
  const tag = cfg.runtime.image;
  await assertOwnTag(cfg, tag);
  say(`docker build -t ${tag} -f ${file} ${context}`);
  let last = 0;
  const r = await dockerCli(['build', '--progress=plain', '-t', tag, '-f', file, '--label', `bm.project=${cfg.id}`, context], {
    cwd: context,
    signal,
    timeoutMs: 3_600_000,
    onLine: (l) => {
      // Keep step headers, errors and at most one progress line every 2 s.
      if (/^#\d+ \[|ERROR|error|DONE|CACHED|naming to/.test(l) || Date.now() - last > 2000) {
        last = Date.now();
        say(l);
      }
    },
  });
  if (r.exitCode !== 0) throw new BmError('IMAGE_BUILD', `Сборка образа ${tag} не удалась: ${(r.stderr || r.stdout).trim().split('\n').slice(-4).join(' ')}`);
}

/**
 * The image a build runs is ready: built from runtime.build when the scope uses runtime.image, pulled for «Odoo in
 * Docker» projects (managed Postgres, the official image), otherwise expected to exist already.
 */
export async function ensureImage(cfg: ProjectConfig, image: string, say: (l: string) => void, signal?: AbortSignal): Promise<void> {
  if (cfg.runtime.build && image === cfg.runtime.image) return buildImage(cfg, say, signal);
  if (cfg.postgres.mode === 'managed') await pullImage(image, say, signal);
}

/** Project deletion: the image the app built for the project (only with its bm.project label). */
export async function removeProjectImage(cfg: ProjectConfig, say: (l: string) => void): Promise<void> {
  if (!cfg.runtime.build) return;
  const info = await docker.getImage(cfg.runtime.image).inspect().catch(() => null);
  if (!info || info.Config?.Labels?.['bm.project'] !== cfg.id) return;
  say(`docker image rm ${cfg.runtime.image}`);
  await docker.getImage(cfg.runtime.image).remove({ force: false }).catch((e) => say(`образ: ${(e as Error).message}`));
}
