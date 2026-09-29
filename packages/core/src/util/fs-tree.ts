import fs from 'node:fs';
import path from 'node:path';

/** Hardlinks (or copies) a directory tree on the host: Odoo attachments are immutable (spec 8.3 step 4, D19). */
export async function copyTree(src: string, dst: string, mode: 'hardlink' | 'copy', log: (l: string) => void): Promise<{ files: number; linked: boolean }> {
  let files = 0;
  let linked = mode === 'hardlink';
  const walk = async (s: string, d: string): Promise<void> => {
    await fs.promises.mkdir(d, { recursive: true });
    for (const e of await fs.promises.readdir(s, { withFileTypes: true })) {
      const sp = path.join(s, e.name);
      const dp = path.join(d, e.name);
      if (e.isDirectory()) await walk(sp, dp);
      else if (e.isFile()) {
        if (linked) {
          try {
            await fs.promises.link(sp, dp);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
            log(`хардлинки не поддерживаются (${(err as Error).message}) — копирование`);
            linked = false;
            await fs.promises.copyFile(sp, dp);
          }
        } else await fs.promises.copyFile(sp, dp).catch((err) => {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        });
        files++;
      }
    }
  };
  await walk(src, dst);
  return { files, linked };
}

/** Total size of the files of a directory tree (hardlinked files counted in full); 0 when it is missing. */
export async function treeSize(dir: string): Promise<number> {
  let total = 0;
  const walk = async (d: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) total += (await fs.promises.stat(p).catch(() => null))?.size ?? 0;
    }
  };
  await walk(dir);
  return total;
}
