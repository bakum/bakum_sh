import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { text } from 'node:stream/consumers';
import zlib from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { extractEntry, openZip } from '../src/util/zip';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-zip-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A minimal zip (deflate, no ZIP64); `crc` overrides the stored checksum of an entry. */
function makeZip(file: string, entries: { name: string; data: string; crc?: number }[]): string {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data);
    const packed = zlib.deflateRawSync(raw);
    const name = Buffer.from(e.name);
    const crc = e.crc ?? zlib.crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  const out = path.join(dir, file);
  fs.writeFileSync(out, Buffer.concat([...locals, cd, end]));
  return out;
}

describe('openZip', () => {
  it('lists entries and streams their content', async () => {
    const sql = 'CREATE TABLE t (id int);\n'.repeat(1000);
    const zip = await openZip(makeZip('ok.zip', [{ name: 'dump.sql', data: sql }, { name: 'filestore/ab/abcdef', data: 'png' }]));
    try {
      expect(zip.entries.map((e) => e.fileName)).toEqual(['dump.sql', 'filestore/ab/abcdef']);
      expect(await text(await zip.open(zip.entries[0]!))).toBe(sql);
      const root = path.join(dir, 'fs');
      await extractEntry(zip, zip.entries[1]!, root, 'ab/abcdef');
      expect(fs.readFileSync(path.join(root, 'ab', 'abcdef'), 'utf8')).toBe('png');
    } finally {
      zip.close();
    }
  });

  it('fails on a CRC-32 mismatch', async () => {
    const zip = await openZip(makeZip('bad-crc.zip', [{ name: 'dump.sql', data: 'SELECT 1;', crc: 1234 }]));
    try {
      await expect(text(await zip.open(zip.entries[0]!))).rejects.toThrow(/CRC-32/);
    } finally {
      zip.close();
    }
  });

  it('refuses a path outside the target folder', async () => {
    const zip = await openZip(makeZip('slip.zip', [{ name: 'filestore/x', data: 'x' }]));
    try {
      await expect(extractEntry(zip, zip.entries[0]!, path.join(dir, 'fs2'), '../outside')).rejects.toThrow(/за пределы/);
      expect(fs.existsSync(path.join(dir, 'outside'))).toBe(false);
    } finally {
      zip.close();
    }
  });

  it('rejects a file that is not a zip', async () => {
    const file = path.join(dir, 'not.zip');
    fs.writeFileSync(file, 'plain text');
    await expect(openZip(file)).rejects.toThrow();
  });
});
