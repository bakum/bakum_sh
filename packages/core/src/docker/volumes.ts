import { docker } from './client';

const ANON_LABEL = 'com.docker.volume.anonymous';

/**
 * Anonymous volumes (the image's VOLUME, e.g. /var/lib/odoo of the Odoo image) mounted in a container. Docker removes
 * them with the container (`rm -v`, `compose down -v`) only while they are the container's own: after a recreate
 * compose passes them to the new container by name, and `down -v` leaves them behind (D55).
 */
export async function anonymousVolumes(containerId: string): Promise<string[]> {
  const c = await docker.getContainer(containerId).inspect().catch(() => null);
  const out: string[] = [];
  for (const m of c?.Mounts ?? []) {
    if (m.Type !== 'volume' || !m.Name) continue;
    const v = await docker.getVolume(m.Name).inspect().catch(() => null);
    if (v?.Labels && ANON_LABEL in v.Labels) out.push(m.Name);
  }
  return out;
}

/** Removes those of the volumes that exist and no container (running or not) uses any more. */
export async function removeUnusedVolumes(names: string[], log: (line: string) => void): Promise<void> {
  for (const name of names) {
    if (!(await docker.getVolume(name).inspect().catch(() => null))) continue;
    const users = await docker.listContainers({ all: true, filters: { volume: [name] } });
    if (users.length) {
      log(`том ${name.slice(0, 12)} подключён к ${users.map((u) => (u.Names[0] ?? '').replace(/^\//, '')).join(', ')} — не удаляется`);
      continue;
    }
    log(`docker volume rm ${name.slice(0, 12)}`);
    await docker
      .getVolume(name)
      .remove()
      .catch((e: Error) => log(`том ${name.slice(0, 12)} не удалён: ${e.message}`));
  }
}
