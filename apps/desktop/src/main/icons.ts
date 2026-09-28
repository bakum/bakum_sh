import { nativeImage, type NativeImage } from 'electron';

export type TrayState = 'ok' | 'building' | 'error' | 'idle';

const COLORS: Record<TrayState, [number, number, number]> = {
  ok: [46, 160, 67],
  building: [230, 140, 20],
  error: [215, 50, 50],
  idle: [113, 75, 103],
};

/** Draws the app mark (branch-like ring with a dot) as a BGRA bitmap — no binary assets needed. */
export function drawIcon(size: number, state: TrayState): NativeImage {
  const buf = Buffer.alloc(size * size * 4);
  const [r, g, b] = COLORS[state];
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
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

export function trayImage(state: TrayState): NativeImage {
  const img = drawIcon(16, state);
  img.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: drawIcon(32, state).toBitmap() });
  return img;
}
