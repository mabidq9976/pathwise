// Palette extraction and anti-alias unmixing.
//
// The palette is built only from "stable" pixels (interiors of flat regions), so
// anti-aliased edge blends never become colours of their own. Every pixel is
// then explained either as one palette colour or as a two-colour blend with a
// coverage fraction, which is what lets edges be located to a fraction of a pixel.

export type RGB = [number, number, number];

export interface PaletteColor {
  rgb: RGB;
  lab: RGB;
  /** Share of sampled stable pixels. */
  weight: number;
  /** Binary mode: measured gamma-space luma (0–255) of paper or ink. */
  level?: number;
}

export interface PaletteOptions {
  /** Oklab distance under which two colours are merged. */
  tolerance: number;
  /** 0 = no limit. */
  maxColors: number;
  /** Force a two-colour ink/paper palette. */
  binary: boolean;
  /** Recover colours that only occur in thin lines (default true; off for upscaled input). */
  recoverLines?: boolean;
}

export interface Palette {
  colors: PaletteColor[];
  hasTransparency: boolean;
}

const LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function oklab(r: number, g: number, b: number): RGB {
  const lr = LINEAR[Math.round(r)], lg = LINEAR[Math.round(g)], lb = LINEAR[Math.round(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function dist(a: RGB, b: RGB): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

interface Cluster {
  sum: RGB;
  count: number;
  lab: RGB;
}

function clusterRgb(c: Cluster): RGB {
  return [c.sum[0] / c.count, c.sum[1] / c.count, c.sum[2] / c.count];
}

function refresh(c: Cluster) {
  const [r, g, b] = clusterRgb(c);
  c.lab = oklab(r, g, b);
}

function absorb(into: Cluster, from: Cluster) {
  into.sum[0] += from.sum[0];
  into.sum[1] += from.sum[1];
  into.sum[2] += from.sum[2];
  into.count += from.count;
  refresh(into);
}

export function extractPalette(data: Uint8Array | Uint8ClampedArray, w: number, h: number, opts: PaletteOptions): Palette {
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 300_000)));
  const bins = new Map<number, Cluster>();
  const all = new Map<number, Cluster>();
  let transparent = 0, sampled = 0, stable = 0;

  const add = (map: Map<number, Cluster>, r: number, g: number, b: number) => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let bin = map.get(key);
    if (!bin) map.set(key, (bin = { sum: [0, 0, 0], count: 0, lab: [0, 0, 0] }));
    bin.sum[0] += r;
    bin.sum[1] += g;
    bin.sum[2] += b;
    bin.count++;
  };

  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      sampled++;
      if (data[i + 3] < 128) {
        transparent++;
        continue;
      }
      const r = data[i], g = data[i + 1], b = data[i + 2];
      add(all, r, g, b);
      if (data[i + 3] < 250) continue;
      let flat = true;
      for (let dy = -1; dy <= 1 && flat; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = (ny * w + nx) * 4;
          if (Math.abs(data[j] - r) + Math.abs(data[j + 1] - g) + Math.abs(data[j + 2] - b) > 24 || data[j + 3] < 250) {
            flat = false;
            break;
          }
        }
      }
      if (flat) {
        stable++;
        add(bins, r, g, b);
      }
    }
  }

  const opaque = sampled - transparent;
  const source = stable >= Math.max(16, opaque * 0.02) ? bins : all;
  const hasTransparency = transparent > sampled * 0.001;
  if (source.size === 0) return { colors: [], hasTransparency };

  for (const bin of source.values()) refresh(bin);
  const ordered = [...source.values()].sort((a, b) => b.count - a.count);

  // Greedy seeding, heaviest bins first.
  let clusters: Cluster[] = [];
  for (const bin of ordered) {
    let best: Cluster | null = null, bestD = opts.tolerance;
    for (const c of clusters) {
      const d = dist(c.lab, bin.lab);
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best) absorb(best, bin);
    else clusters.push({ sum: [...bin.sum], count: bin.count, lab: [...bin.lab] });
  }

  // A few k-means passes over the bins to undo seeding order effects.
  for (let iter = 0; iter < 4; iter++) {
    const next: Cluster[] = clusters.map((c) => ({ sum: [0, 0, 0], count: 0, lab: c.lab }));
    for (const bin of ordered) {
      let bi = 0, bd = Infinity;
      clusters.forEach((c, i) => {
        const d = dist(c.lab, bin.lab);
        if (d < bd) { bd = d; bi = i; }
      });
      const t = next[bi];
      t.sum[0] += bin.sum[0];
      t.sum[1] += bin.sum[1];
      t.sum[2] += bin.sum[2];
      t.count += bin.count;
    }
    clusters = next.filter((c) => c.count > 0);
    clusters.forEach(refresh);
  }

  const total = clusters.reduce((n, c) => n + c.count, 0);
  // Tiny clusters are residue (noise, compression artefacts); their pixels unmix into neighbours.
  clusters = clusters.filter((c) => c.count >= Math.max(2, total * 0.0004));

  const mergeClosest = (limit: number) => {
    while (clusters.length > 1) {
      let bi = -1, bj = -1, bd = Infinity;
      for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
          const d = dist(clusters[i].lab, clusters[j].lab);
          if (d < bd) { bd = d; bi = i; bj = j; }
        }
      }
      if (bd >= opts.tolerance && clusters.length <= limit) break;
      absorb(clusters[bi], clusters[bj]);
      clusters.splice(bj, 1);
    }
  };
  mergeClosest(opts.binary ? 2 : opts.maxColors > 0 ? opts.maxColors : Infinity);

  let colors: PaletteColor[] = clusters
    .map((c) => ({ rgb: clusterRgb(c).map(Math.round) as RGB, lab: c.lab, weight: c.count / total }))
    .sort((a, b) => b.weight - a.weight);

  // Duplicates sit within ~1.5× the merge tolerance of a major colour; AI-upscaled
  // input (no thin-line recovery) inflates compression noise further, so 2×.
  const dupFactor = opts.recoverLines === false ? 2 : 1.5;
  if (!opts.binary) colors = pruneMinorColours(colors, opts.tolerance * dupFactor);

  if (!opts.binary && opts.recoverLines !== false && source === bins && (opts.maxColors === 0 || colors.length < opts.maxColors)) {
    for (const extra of recoverLineColors(data, w, h, step, colors, opts.tolerance)) {
      if (opts.maxColors > 0 && colors.length >= opts.maxColors) break;
      colors.push(extra);
    }
    colors = pruneMinorColours(colors, opts.tolerance * dupFactor);
  }

  if (opts.binary) {
    // Paper is the lighter colour, ink the darker; both are output as pure
    // white/black, but `level` keeps their measured gamma-space luma so ink
    // coverage can be solved linearly (see unmix).
    const byL = [...colors].sort((a, b) => b.lab[0] - a.lab[0]);
    const paper = byL[0] ? luma(...byL[0].rgb) : 255;
    const ink = byL.length > 1 ? luma(...byL[byL.length - 1].rgb) : 0;
    colors = [
      { rgb: [255, 255, 255], lab: [1, 0, 0], weight: 0.5, level: paper },
      { rgb: [0, 0, 0], lab: [0, 0, 0], weight: 0.5, level: Math.min(ink, paper - 40) },
    ];
  }
  return { colors, hasTransparency };
}

/** Gamma-encoded luma. Linear in the blend fraction when edges are anti-aliased in sRGB. */
export function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export interface Unmixed {
  /** Primary palette index per pixel (255 = none). */
  a: Uint8Array;
  /** Secondary palette index (equal to `a` when the pixel is not a blend). */
  b: Uint8Array;
  /** Coverage of `a`; `b` has 1 - cov. */
  cov: Float32Array;
  /** Opacity 0–1, or null when the image is fully opaque. */
  alpha: Float32Array | null;
  /**
   * Binary mode with local-contrast recovery: the unboosted coverage. The
   * boosted `cov` decides whether a faint line exists; this one measures its
   * true width (summed ink), so faint hatching stays thin.
   */
  geom?: Float32Array;
}

/**
 * Explains each pixel as a palette colour or a blend of two. Blends are solved
 * in gamma-encoded sRGB, which is how most rasterisers anti-alias.
 *
 * A blend may only use colours that appear as solid pixels in the 5×5
 * neighbourhood: an edge pixel between red and cream must not be explained as
 * red + yellow just because that pair happens to fit its RGB value slightly
 * better. Without this, coverage jitters between layers and edges wobble.
 */
export function unmix(
  data: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  palette: Palette,
  binary: boolean,
  /** Binary mode: radius of local-contrast recovery (0 = global levels only). */
  localRadius = 0,
): Unmixed {
  const n = w * h;
  const k = palette.colors.length;
  const a = new Uint8Array(n).fill(255);
  const b = new Uint8Array(n).fill(255);
  const cov = new Float32Array(n);
  const alpha = palette.hasTransparency ? new Float32Array(n) : null;
  const pr = new Float64Array(k), pg = new Float64Array(k), pb = new Float64Array(k);
  palette.colors.forEach((c, i) => {
    pr[i] = c.rgb[0] / 255;
    pg[i] = c.rgb[1] / 255;
    pb[i] = c.rgb[2] / 255;
  });
  if (k === 0) return { a, b, cov, alpha };

  if (binary) {
    // Ink coverage from gamma-space luma, which is linear in the blend fraction.
    // (Perceptual lightness such as Oklab L is not: a 50% edge pixel would read
    // as ~35–65% coverage, shifting edges unevenly and making strokes wobble.)
    const paper = palette.colors[0].level ?? 255;
    const ink = palette.colors[1].level ?? 0;
    const range = Math.max(1, paper - ink);
    const L = new Float32Array(n);
    for (let p = 0; p < n; p++) L[p] = luma(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]);
    const local = localRadius > 0 ? localLevels(L, w, h, localRadius) : null;
    const geom = local ? new Float32Array(n) : undefined;
    for (let p = 0; p < n; p++) {
      const op = data[p * 4 + 3] / 255;
      if (alpha) alpha[p] = op;
      if (op === 0) continue;
      a[p] = 1;
      b[p] = 0;
      let c = Math.min(1, Math.max(0, (paper - L[p]) / range));
      if (geom) geom[p] = c;
      if (local) {
        // Local contrast recovery: blurred hairlines (a white gap greyed to ~120
        // inside dark-grey ink, a thin dark line faded to ~150 on white) never
        // cross the global 50% level, though a viewer plainly sees them. Judge
        // such pixels against the darkest and lightest values around them,
        // blending in only where the local swing is real structure, not noise.
        // Only where a feature would otherwise be lost: a dark line whose
        // darkest pixel stays below ~70% ink, or a light gap whose lightest
        // pixel stays above ~30% ink. Clearly visible strokes keep their exact
        // global geometry, since boosting them would widen thin strokes to the blur.
        const lo = local.lo[p], hi = local.hi[p], swing = hi - lo;
        const darkest = (paper - lo) / range, lightest = (paper - hi) / range;
        const faint = Math.max(Math.min(1, Math.max(0, (0.7 - darkest) / 0.2)), Math.min(1, Math.max(0, (lightest - 0.3) / 0.2)));
        const weight = faint * Math.min(1, Math.max(0, (swing / range - 0.22) / 0.2));
        if (weight > 0) c = (1 - weight) * c + weight * Math.min(1, Math.max(0, (hi - L[p]) / swing));
      }
      cov[p] = c;
    }
    return { a, b, cov, alpha, geom };
  }

  // Pass 1: nearest colour per pixel; "solid" when it matches closely.
  const PURE = 0.045;
  const nearest = new Uint8Array(n);
  const solid = new Uint8Array(n).fill(255);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const op = data[i + 3] / 255;
    if (alpha) alpha[p] = op;
    if (op === 0) continue;
    const r = data[i] / 255, g = data[i + 1] / 255, bl = data[i + 2] / 255;
    let best = 0, bestD = Infinity;
    for (let c = 0; c < k; c++) {
      const d = (pr[c] - r) ** 2 + (pg[c] - g) ** 2 + (pb[c] - bl) ** 2;
      if (d < bestD) { bestD = d; best = c; }
    }
    nearest[p] = best;
    if (Math.sqrt(bestD) < PURE && op > 0.98) solid[p] = best;
  }

  // A close colour match is only trusted when neighbours agree: a pale blend of
  // white and navy can sit within PURE of cream by coincidence, and taking it
  // as solid cream puts a full-coverage bump on the edge. Real regions (even
  // 1 px lines) have at least two agreeing neighbours.
  const tentative = solid.slice();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const s = tentative[p];
      if (s === 255) continue;
      let agree = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h && tentative[yy * w + xx] === s) agree++;
        }
      }
      if (agree < 2) solid[p] = 255;
    }
  }

  // Pass 2: solid pixels keep their colour; the rest are unmixed against the
  // colours that are actually present around them.
  const cand: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (data[p * 4 + 3] === 0) continue;
      if (solid[p] !== 255) {
        a[p] = b[p] = solid[p];
        cov[p] = 1;
        continue;
      }
      cand.length = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const s = solid[yy * w + xx];
          if (s !== 255 && !cand.includes(s)) cand.push(s);
        }
      }
      // Thin features (hairlines, sawtooth and star tips) have no solid core, so
      // only the background shows up as a solid neighbour. The pixel is then a
      // blend of that colour and *some* palette colour: try every partner, not
      // just the colours nearest in RGB (a 50% cream/dark-teal hairline pixel
      // is closer to mid teal than to dark teal, which used to leave teal
      // specks along every hairline).
      let anchor = -1;
      if (cand.length < 2) {
        const i = p * 4;
        const order = [...Array(k).keys()].sort(
          (u, v) =>
            (pr[u] * 255 - data[i]) ** 2 + (pg[u] * 255 - data[i + 1]) ** 2 + (pb[u] * 255 - data[i + 2]) ** 2 -
            ((pr[v] * 255 - data[i]) ** 2 + (pg[v] * 255 - data[i + 1]) ** 2 + (pb[v] * 255 - data[i + 2]) ** 2),
        );
        if (cand.length === 1) anchor = cand[0];
        for (const c of anchor >= 0 ? order.slice(0, 32) : order.slice(0, 6)) if (!cand.includes(c)) cand.push(c);
      }

      const i = p * 4;
      const r = data[i] / 255, g = data[i + 1] / 255, bl = data[i + 2] / 255;
      let single = Infinity, singleC = nearest[p];
      for (const c of cand) {
        const d = Math.hypot(pr[c] - r, pg[c] - g, pb[c] - bl);
        if (d < single) { single = d; singleC = c; }
      }
      let bestR = Infinity, bestA = singleC, bestB = singleC, bestT = 0;
      for (let u = 0; u < cand.length; u++) {
        for (let v = u + 1; v < cand.length; v++) {
          const A = cand[u], B = cand[v];
          if (anchor >= 0 && A !== anchor && B !== anchor) continue;
          const dr = pr[B] - pr[A], dg = pg[B] - pg[A], db = pb[B] - pb[A];
          const len2 = dr * dr + dg * dg + db * db;
          if (len2 < 1e-9) continue;
          const t = Math.min(1, Math.max(0, ((r - pr[A]) * dr + (g - pg[A]) * dg + (bl - pb[A]) * db) / len2));
          const res = Math.hypot(r - pr[A] - t * dr, g - pg[A] - t * dg, bl - pb[A] - t * db);
          if (res < bestR) { bestR = res; bestA = A; bestB = B; bestT = t; }
        }
      }
      if (bestR < single * 0.75 && bestR < 0.15 && bestT > 0.01 && bestT < 0.99) {
        a[p] = bestA;
        b[p] = bestB;
        cov[p] = 1 - bestT;
      } else {
        a[p] = b[p] = singleC;
        cov[p] = 1;
      }
    }
  }
  return { a, b, cov, alpha };
}

/**
 * Local ink and paper levels: min and max luma over a (2r+1)² window
 * (separable), lightly smoothed so the levels do not step from pixel to pixel.
 */
function localLevels(L: Float32Array, w: number, h: number, r: number): { lo: Float32Array; hi: Float32Array } {
  const pass = (src: Float32Array, horizontal: boolean, pick: (a: number, b: number) => number) => {
    const out = new Float32Array(src.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = src[y * w + x];
        for (let k = -r; k <= r; k++) {
          const xx = horizontal ? x + k : x, yy = horizontal ? y : y + k;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h) v = pick(v, src[yy * w + xx]);
        }
        out[y * w + x] = v;
      }
    }
    return out;
  };
  const box = (src: Float32Array) => {
    const out = new Float32Array(src.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < w && yy < h) { s += src[yy * w + xx]; c++; }
          }
        }
        out[y * w + x] = s / c;
      }
    }
    return out;
  };
  const lo = box(pass(pass(L, true, Math.min), false, Math.min));
  const hi = box(pass(pass(L, true, Math.max), false, Math.max));
  return { lo, hi };
}

/**
 * Colours that only occur in thin features. A 1–2 px line has no interior
 * pixel, so it never contributes a "stable" sample and its colour is missing
 * from the palette, and the line would vanish. Its pixels are blends between
 * the background P and the unknown line colour L, all lying on the segment
 * P → L. Pixels the palette cannot explain are grouped by (P, direction), and
 * L is read from the most extreme members, the line's core.
 */
function recoverLineColors(
  data: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  step: number,
  colors: PaletteColor[],
  tolerance: number,
): PaletteColor[] {
  const k = colors.length;
  if (k === 0) return [];
  const pal = colors.map((c) => c.rgb.map((v) => v / 255) as RGB);
  interface Group { base: number; dir: RGB; reach: number[]; count: number }
  const groups: Group[] = [];
  let sampled = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 250) continue;
      sampled++;
      const c: RGB = [data[i] / 255, data[i + 1] / 255, data[i + 2] / 255];
      // Every pair, not just the nearest few: a 50% white/navy blend is nearer
      // to yellow or red than to navy, and must still count as explained.
      const order = [...Array(k).keys()].sort((u, v) => dist(pal[u], c) - dist(pal[v], c)).slice(0, 40);
      const base = order[0];
      const reach = dist(pal[base], c);
      if (reach < 0.08) continue; // close to a palette colour
      let explained = false;
      for (let u = 0; u < order.length && !explained; u++) {
        for (let v = u + 1; v < order.length; v++) {
          const A = pal[order[u]], B = pal[order[v]];
          const d: RGB = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
          const l2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
          if (l2 < 1e-9) continue;
          const t = Math.min(1, Math.max(0, ((c[0] - A[0]) * d[0] + (c[1] - A[1]) * d[1] + (c[2] - A[2]) * d[2]) / l2));
          if (Math.hypot(c[0] - A[0] - t * d[0], c[1] - A[1] - t * d[1], c[2] - A[2] - t * d[2]) < 0.04) {
            explained = true;
            break;
          }
        }
      }
      if (explained) continue;
      const dir: RGB = [(c[0] - pal[base][0]) / reach, (c[1] - pal[base][1]) / reach, (c[2] - pal[base][2]) / reach];
      let g = groups.find((gr) => gr.base === base && gr.dir[0] * dir[0] + gr.dir[1] * dir[1] + gr.dir[2] * dir[2] > Math.cos((8 * Math.PI) / 180));
      if (!g) groups.push((g = { base, dir, reach: [], count: 0 }));
      g.reach.push(reach);
      g.count++;
    }
  }
  const out: PaletteColor[] = [];
  for (const g of groups) {
    if (g.count < Math.max(12, sampled * 0.0004)) continue;
    g.reach.sort((a, b) => a - b);
    const core = g.reach[Math.floor(g.reach.length * 0.9)];
    const P = pal[g.base];
    const rgb = [0, 1, 2].map((ch) => Math.round(Math.min(1, Math.max(0, P[ch] + g.dir[ch] * core)) * 255)) as RGB;
    const lab = oklab(rgb[0], rgb[1], rgb[2]);
    if ([...colors, ...out].some((c) => dist(c.lab, lab) < tolerance * 1.5)) continue;
    out.push({ rgb, lab, weight: g.count / Math.max(1, sampled) });
  }
  return out;
}

/**
 * Minor colours (under 1.5% of the image) that are not design colours:
 * - near-duplicates of a much more common colour (noise or compression shifts
 *   of the same navy);
 * - blends lying on the mixing line between two much more common colours (a
 *   wide blurred or AI-upscaled red/navy boundary reads as solid maroon).
 * Dropping them lets those pixels unmix into the real colours.
 */
function pruneMinorColours(colors: PaletteColor[], dupDistance: number): PaletteColor[] {
  const keep: PaletteColor[] = [];
  for (const c of colors) {
    let blend = false;
    if (c.weight < 0.015) {
      blend = colors.some((o) => o !== c && o.weight >= c.weight * 5 && dist(o.lab, c.lab) < dupDistance);
      const v = c.rgb.map((x) => x / 255);
      for (let i = 0; i < colors.length && !blend; i++) {
        for (let j = i + 1; j < colors.length && !blend; j++) {
          const A = colors[i], B = colors[j];
          if (A === c || B === c || A.weight < c.weight * 3 || B.weight < c.weight * 3) continue;
          const a = A.rgb.map((x) => x / 255), b = B.rgb.map((x) => x / 255);
          const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
          const l2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
          if (l2 < 1e-6) continue;
          const t = ((v[0] - a[0]) * d[0] + (v[1] - a[1]) * d[1] + (v[2] - a[2]) * d[2]) / l2;
          if (t < 0.12 || t > 0.88) continue;
          const res = Math.hypot(v[0] - a[0] - t * d[0], v[1] - a[1] - t * d[1], v[2] - a[2] - t * d[2]);
          if (res < 0.035) blend = true;
        }
      }
    }
    if (!blend) keep.push(c);
  }
  return keep;
}
