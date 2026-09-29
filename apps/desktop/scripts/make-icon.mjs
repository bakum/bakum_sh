// Writes resources/icon.ico (exe, installer and shortcut icon) from the same mark the app draws for its window
// and tray, so packaging never falls back to Electron's default icon. Run by `pnpm package`; needs Node type
// stripping (--experimental-strip-types before Node 22.18) to load icon-mark.ts.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const target = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'icon.ico');
mkdirSync(path.dirname(target), { recursive: true });
writeFileSync(target, Buffer.concat([header, ...images]));
console.log(`icon: ${path.relative(process.cwd(), target)} (${SIZES.join(', ')} px)`);
