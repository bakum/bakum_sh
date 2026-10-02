// Writes resources/icon.ico (exe, installer and shortcut icon) and resources/icon.png (1024 px, electron-builder makes
// the macOS .icns from it, D67) from the same mark the app draws for its window and tray, so packaging never falls back
// to Electron's default icon. Run by `pnpm package` / `package:mac`; needs Node type stripping
// (--experimental-strip-types before Node 22.18) to load icon-mark.ts.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { markPixels } from '../src/main/icon-mark.ts';

const IDLE = [113, 75, 103]; // COLORS.idle in src/main/icons.ts
const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

/** One icon image as a 32-bit DIB: BITMAPINFOHEADER, bottom-up BGRA rows, empty AND mask (alpha does the job). */
function dib(size) {
  const px = markPixels(size, IDLE);
  const maskRow = Math.ceil(size / 32) * 4;
  const out = Buffer.alloc(40 + size * size * 4 + maskRow * size);
  out.writeUInt32LE(40, 0);
  out.writeInt32LE(size, 4);
  out.writeInt32LE(size * 2, 8); // XOR image + AND mask
  out.writeUInt16LE(1, 12);
  out.writeUInt16LE(32, 14);
  for (let y = 0; y < size; y++) {
    const row = px.subarray((size - 1 - y) * size * 4, (size - y) * size * 4);
    out.set(row, 40 + y * size * 4);
  }
  return out;
}

const images = SIZES.map(dib);
const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach((img, i) => {
  const e = 6 + 16 * i;
  header.writeUInt8(SIZES[i] % 256, e); // 0 means 256
  header.writeUInt8(SIZES[i] % 256, e + 1);
  header.writeUInt16LE(1, e + 4);
  header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(img.length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += img.length;
});

const resources = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources');
const target = path.join(resources, 'icon.ico');
mkdirSync(resources, { recursive: true });
writeFileSync(target, Buffer.concat([header, ...images]));
console.log(`icon: ${path.relative(process.cwd(), target)} (${SIZES.join(', ')} px)`);

/**
 * macOS app icon: 1024 px RGBA PNG; the mark takes the inner 80 % like other macOS icons. markPixels gives BGRA rows,
 * PNG wants RGBA with a filter byte (0) in front of each row.
 */
function png(size, inner) {
  const mark = markPixels(inner, IDLE);
  const pad = (size - inner) / 2;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < inner; y++) {
    for (let x = 0; x < inner; x++) {
      const i = (y * inner + x) * 4;
      const o = (y + pad) * (size * 4 + 1) + 1 + (x + pad) * 4;
      raw[o] = mark[i + 2];
      raw[o + 1] = mark[i + 1];
      raw[o + 2] = mark[i];
      raw[o + 3] = mark[i + 3];
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const pngTarget = path.join(resources, 'icon.png');
writeFileSync(pngTarget, png(1024, 820));
console.log(`icon: ${path.relative(process.cwd(), pngTarget)} (1024 px)`);
