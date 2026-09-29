import { nativeImage, type NativeImage } from 'electron';
import { markPixels, type Rgb } from './icon-mark';

export type TrayState = 'ok' | 'building' | 'error' | 'idle';

// `idle` is also the colour of the exe icon (scripts/make-icon.mjs).
const COLORS: Record<TrayState, Rgb> = {
  ok: [46, 160, 67],
  building: [230, 140, 20],
  error: [215, 50, 50],
  idle: [113, 75, 103],
};

/** Draws the app mark as a bitmap — no binary assets needed. */
export function drawIcon(size: number, state: TrayState): NativeImage {
  return nativeImage.createFromBitmap(Buffer.from(markPixels(size, COLORS[state])), { width: size, height: size });
}

export function trayImage(state: TrayState): NativeImage {
  const img = drawIcon(16, state);
  img.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: drawIcon(32, state).toBitmap() });
  return img;
}
