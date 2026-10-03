import fs from 'node:fs';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import yauzl from 'yauzl';
import { isInside } from './paths';
import { t } from '../i18n';

/**
 * A zip archive read on the host (D61): the entries come from the central directory (ZIP64 included — dump.sql of a
 * production backup is over 4 GB), content is streamed and checked against the entry's CRC-32.
 */
export interface ZipReader {
  entries: yauzl.Entry[];
  open(entry: yauzl.Entry): Promise<Readable>;
  close(): void;
}

export function openZip(file: string): Promise<ZipReader> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zf) => {
      if (err) return reject(err);
      const entries: yauzl.Entry[] = [];
      zf.on('entry', (e: yauzl.Entry) => {
        entries.push(e);
        zf.readEntry();
      });
      zf.on('error', (e: Error) => {
        zf.close();
        reject(e);
      });
      zf.on('end', () =>
        resolve({
          entries,
          open: async (entry) => {
            if (entry.isEncrypted()) throw new Error(t('zip.encrypted', { name: entry.fileName }));
            const src = await zf.openReadStreamPromise(entry);
            const check = crcCheck(entry.crc32, entry.fileName);
            src.on('error', (e) => check.destroy(e));
            return src.pipe(check);
          },
          close: () => zf.close(),
        }),
      );
      zf.readEntry();
    });
  });
}

function crcCheck(expected: number, name: string): Transform {
  let crc = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      crc = zlib.crc32(chunk, crc);
      cb(null, chunk);
    },
    flush(cb) {
      cb(crc >>> 0 === expected >>> 0 ? null : new Error(t('zip.crc', { name })));
    },
  });
}

/** Unpacks one entry to `root/rel`; a path leading outside `root` is refused. */
export async function extractEntry(zip: ZipReader, entry: yauzl.Entry, root: string, rel: string): Promise<void> {
  const target = path.resolve(root, rel);
  if (!isInside(root, target)) throw new Error(t('zip.outside', { name: entry.fileName, root }));
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await pipeline(await zip.open(entry), fs.createWriteStream(target));
}
