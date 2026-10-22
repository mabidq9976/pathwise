// Native-resolution analysis. Many inputs are small images that were enlarged
// before they reached us: with nearest-neighbour (hard k×k blocks) or with
// smoothing (edges blurred over several pixels). Tracing those at face value
// follows the enlarged pixel steps and JPEG lumps, so we estimate how many
// image pixels make up one real pixel and trace at that scale instead.

const luma = (d: ArrayLike<number>, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

/**
 * Block size k ≥ 2 when the image is a nearest-neighbour enlargement (every
 * colour change lands on a k-pixel grid in both directions), else 1.
 */
export function detectBlockSize(data: ArrayLike<number>, w: number, h: number): number {
  return blockGrid(data, w, h).k;
}

function blockGrid(data: ArrayLike<number>, w: number, h: number): { k: number; px: number; py: number } {
  const MAX = 16;
  // hits[k][i % k] for every colour change at position i, in one pass per axis.
  const lines = (horizontal: boolean) => {
    const hits = Array.from({ length: MAX + 1 }, (_, k) => new Float64Array(Math.max(1, k)));
    let total = 0;
    const [outer, inner] = horizontal ? [h, w] : [w, h];
    const step = Math.max(1, Math.floor(outer / 400));
    for (let o = 0; o < outer; o += step) {
      for (let i = 1; i < inner; i++) {
        const p = horizontal ? (o * w + i) * 4 : (i * w + o) * 4;
        const q = horizontal ? p - 4 : p - w * 4;
        if (Math.abs(data[p] - data[q]) + Math.abs(data[p + 1] - data[q + 1]) + Math.abs(data[p + 2] - data[q + 2]) > 18) {
          for (let k = 2; k <= MAX; k++) hits[k][i % k]++;
          total++;
        }
      }
    }
    return (k: number) => {
      if (total < 200) return { frac: 0, phase: 0 };
      let phase = 0;
      for (let j = 1; j < k; j++) if (hits[k][j] > hits[k][phase]) phase = j;
      return { frac: hits[k][phase] / total, phase };
    };
  };
  const byX = lines(true), byY = lines(false);
  for (let k = MAX; k >= 2; k--) {
    if (w < k * 16 || h < k * 16) continue;
    const x = byX(k), y = byY(k);
    if (x.frac > 0.9 && y.frac > 0.9) return { k, px: x.phase, py: y.phase };
  }
  return { k: 1, px: 0, py: 0 };
}

/**
 * Median 10–90% width (px) of high-contrast edges, measured along rows and
 * columns. Crisp anti-aliased art measures ~1; an image enlarged k× with
 * smoothing measures roughly k.
 */
export function edgeWidth(data: ArrayLike<number>, w: number, h: number): number {
  const widths: number[] = [];
  const scan = (horizontal: boolean) => {
    const [outer, inner] = horizontal ? [h, w] : [w, h];
    const step = Math.max(1, Math.floor(outer / 300));
    const L = new Float64Array(inner);
    for (let o = 2; o < outer - 2; o += step) {
      for (let i = 0; i < inner; i++) L[i] = luma(data, horizontal ? (o * w + i) * 4 : (i * w + o) * 4);
      let i = 1;
      while (i < inner - 1) {
        const dir = Math.sign(L[i + 1] - L[i]);
        if (dir === 0 || Math.abs(L[i + 1] - L[i]) < 6) { i++; continue; }
        // Extend the monotone run (small JPEG wiggles allowed).
        let a = i, b = i + 1;
        while (a > 0 && (L[a] - L[a - 1]) * dir > -2 && Math.abs(L[a] - L[a - 1]) > 0.5) a--;
        while (b < inner - 1 && (L[b + 1] - L[b]) * dir > -2 && Math.abs(L[b + 1] - L[b]) > 0.5) b++;
        const lo = L[a], hi = L[b], c = (hi - lo) * dir;
        if (c > 120 && b - a < 40) {
          const cross = (f: number) => {
            const target = lo + (hi - lo) * f;
            for (let j = a; j < b; j++) {
              const u = (L[j] - target) * dir, v = (L[j + 1] - target) * dir;
              if (u <= 0 && v > 0) return j + -u / (v - u);
            }
            return b;
          };
          widths.push(cross(0.9) - cross(0.1));
        }
        i = b + 1;
      }
    }
  };
  scan(true);
  scan(false);
  if (widths.length < 50) return 1;
  widths.sort((x, y) => x - y);
  return widths[widths.length >> 1];
}

/** Undoes a k× nearest-neighbour enlargement, then re-enlarges it bilinearly so edges are smooth ramps again. */
export function restoreBlocky(data: ArrayLike<number>, w: number, h: number, k: number, px = 0, py = 0): Uint8ClampedArray<ArrayBuffer> {
  // Blocks start at px/py (where colour changes line up); block 0 may be partial.
  const ox = px % k - k, oy = py % k - k;
  const nw = Math.ceil((w - ox) / k), nh = Math.ceil((h - oy) / k);
  const small = new Float32Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, Math.max(0, ox + x * k + (k >> 1))), sy = Math.min(h - 1, Math.max(0, oy + y * k + (k >> 1)));
      for (let c = 0; c < 4; c++) small[(y * nw + x) * 4 + c] = data[(sy * w + sx) * 4 + c];
    }
  }
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(nh - 1, Math.max(0, (y - oy + 0.5) / k - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(nh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(nw - 1, Math.max(0, (x - ox + 0.5) / k - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(nw - 1, x0 + 1), tx = fx - x0;
      for (let c = 0; c < 4; c++) {
        const top = small[(y0 * nw + x0) * 4 + c] * (1 - tx) + small[(y0 * nw + x1) * 4 + c] * tx;
        const bot = small[(y1 * nw + x0) * 4 + c] * (1 - tx) + small[(y1 * nw + x1) * 4 + c] * tx;
        out[(y * w + x) * 4 + c] = top * (1 - ty) + bot * ty;
      }
    }
  }
  return out;
}

export interface NativeResolution {
  /** Image pixels per real pixel (1 = the image is at its native resolution). */
  scale: number;
  /** Pixels to trace: the input, or a smoothed copy when it was blocky. */
  data: Uint8ClampedArray<ArrayBuffer>;
  reason: 'native' | 'blocky' | 'soft';
}

export function analyzeResolution(data: Uint8ClampedArray<ArrayBuffer>, w: number, h: number): NativeResolution {
  const { k, px, py } = blockGrid(data, w, h);
  if (k >= 2) return { scale: k, data: restoreBlocky(data, w, h, k, px, py), reason: 'blocky' };
  // Crisp anti-aliased edges measure ~1.5 px; a k× smooth enlargement ~k + 1.1.
  const width = edgeWidth(data, w, h);
  const scale = width >= 3 ? Math.min(8, width - 1.2) : 1;
  return { scale, data, reason: scale > 1 ? 'soft' : 'native' };
}
