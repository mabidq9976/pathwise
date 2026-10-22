// Fidelity check: render the vector back and compare it with the source pixels.
// Errors concentrate at edges (flat interiors match trivially), so the score is
// measured on pixels within one pixel of a colour edge in the source.

import { pathData, type VectorDoc } from './vector.ts';

export interface Fidelity {
  /** 100 × (1 − edge error / 255). */
  match: number;
  /** Mean absolute difference (0–255) over edge pixels. */
  edgeError: number;
}

/** Needs OffscreenCanvas + Path2D (browsers and workers); null elsewhere. */
export function measureFidelity(doc: VectorDoc, data: Uint8Array | Uint8ClampedArray, w: number, h: number): Fidelity | null {
  if (typeof OffscreenCanvas === 'undefined' || typeof Path2D === 'undefined') return null;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.scale(w / doc.width, h / doc.height);
  for (const shape of doc.shapes) {
    ctx.fillStyle = shape.fill;
    ctx.fill(new Path2D(pathData(shape.segs, 3)));
  }
  const out = ctx.getImageData(0, 0, w, h).data;

  // Source composited over white, like the render.
  const n = w * h;
  const src = new Uint8ClampedArray(n * 3);
  for (let p = 0; p < n; p++) {
    const a = data[p * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) src[p * 3 + c] = data[p * 4 + c] * a + 255 * (1 - a);
  }

  const stride = n > 4_000_000 ? 2 : 1;
  let sum = 0, count = 0;
  for (let y = 1; y < h - 1; y += stride) {
    for (let x = 1; x < w - 1; x += stride) {
      const p = y * w + x;
      let edge = false;
      for (let dy = -1; dy <= 1 && !edge; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const q = p + dy * w + dx;
          if (Math.abs(src[p * 3] - src[q * 3]) + Math.abs(src[p * 3 + 1] - src[q * 3 + 1]) + Math.abs(src[p * 3 + 2] - src[q * 3 + 2]) > 60) {
            edge = true;
            break;
          }
        }
      }
      if (!edge) continue;
      sum += (Math.abs(src[p * 3] - out[p * 4]) + Math.abs(src[p * 3 + 1] - out[p * 4 + 1]) + Math.abs(src[p * 3 + 2] - out[p * 4 + 2])) / 3;
      count++;
    }
  }
  const edgeError = count ? sum / count : 0;
  return { match: 100 * (1 - edgeError / 255), edgeError };
}
