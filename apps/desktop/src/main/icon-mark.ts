// Pure pixel drawing of the app mark, shared by the runtime icons (icons.ts) and scripts/make-icon.mjs,
// which loads this file through Node's type stripping — keep it free of imports and non-erasable TS syntax.

export type Rgb = [number, number, number];

/** The app mark (branch-like ring with a dot) as size×size BGRA pixels with antialiased edges. */
export function markPixels(size: number, [r, g, b]: Rgb): Uint8Array {
  const buf = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  const outer = size / 2 - 0.5;
  const ring = size * 0.14;
  const dot = size * 0.2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      let a = 0;
      if (d <= outer && d >= outer - ring) a = Math.min(1, outer - d + 0.5, d - (outer - ring) + 0.5);
      else if (d <= dot) a = Math.min(1, dot - d + 0.5);
      const i = (y * size + x) * 4;
      buf[i] = b;
      buf[i + 1] = g;
      buf[i + 2] = r;
      buf[i + 3] = Math.round(Math.max(0, a) * 255);
    }
  }
  return buf;
}
