// Precision engine: palette → anti-alias unmixing → sub-pixel region contours →
// corner-aware curve fitting. Produces a VectorDoc directly.

import { rgbToHex, type Seg, type Shape, type VectorDoc } from '../vector.ts';
import { bounds, ContourTracer, pointInPolygon, refineEdges, signedArea, type Contour } from './contours.ts';
import { fitContour, type FitOptions } from './fit.ts';
import type { SymmetryOptions } from './symmetry.ts';
import { extractPalette, unmix } from './palette.ts';

export interface PrecisionOptions {
  stacking: 'stacked' | 'cutout';
  binary: boolean;
  /** Oklab distance under which colours merge. */
  colorTolerance: number;
  /** 0 = automatic. */
  maxColors: number;
  /** Shapes and holes smaller than this (px²) are dropped. */
  minArea: number;
  cornerAngle: number;
  fitTolerance: number;
  /** Taubin fairing iterations (default 6). */
  fairing?: number;
  /** Fewest-node optimal fitting (default true). */
  optimal?: boolean;
  /** Tolerance for rasteriser facets merged into one curve (default 0.5 px). */
  fairTolerance?: number;
  /** Lines within this many degrees of 0/45/90° snap exactly (default 1.5). */
  snapAngle?: number;
  /** Black & white: radius of local-contrast recovery for blurred hairlines (0 = off). */
  localContrast?: number;
  /** Image pixels per original-artwork pixel (> 1 when AI-enhanced); see FitOptions.scale. */
  scale?: number;
  /** Make near-symmetric features (domes, arches, star points) exactly symmetric; omitted = off. */
  symmetry?: SymmetryOptions;
  /** Recover colours that only occur in thin lines (default true; off for AI-upscaled input). */
  recoverLines?: boolean;
  /** Optional hook receiving each corner decision (diagnostics; see FitOptions.debug). */
  debug?: FitOptions['debug'];
  /** Optional per-stage timing (diagnostics). */
  onTiming?: (stage: string, ms: number) => void;
}

export function precisionTrace(data: Uint8Array | Uint8ClampedArray, w: number, h: number, opts: PrecisionOptions): VectorDoc {
  const clock = { t: performance.now() };
  const lap = (stage: string) => {
    const now = performance.now();
    opts.onTiming?.(stage, now - clock.t);
    clock.t = now;
  };
  const palette = extractPalette(data, w, h, { tolerance: opts.colorTolerance, maxColors: opts.maxColors, binary: opts.binary, recoverLines: opts.recoverLines });
  lap('palette');
  const k = palette.colors.length;
  if (k === 0) return { width: w, height: h, shapes: [] };
  const mix = unmix(data, w, h, palette, opts.binary, opts.localContrast ?? 0);
  lap('unmix');

  // Layer order: the colour that owns the border is the background, then by area.
  const area = new Float64Array(k), border = new Float64Array(k);
  for (let p = 0; p < w * h; p++) {
    const a = mix.a[p];
    if (a === 255) continue;
    const op = mix.alpha ? mix.alpha[p] : 1;
    const x = p % w, y = (p - x) / w;
    const onBorder = x === 0 || y === 0 || x === w - 1 || y === h - 1;
    area[a] += mix.cov[p] * op;
    area[mix.b[p]] += (1 - mix.cov[p]) * op;
    if (onBorder) {
      border[a] += mix.cov[p] * op;
      border[mix.b[p]] += (1 - mix.cov[p]) * op;
    }
  }
  let order = [...Array(k).keys()].sort((i, j) => area[j] - area[i]);
  const bg = [...Array(k).keys()].sort((i, j) => border[j] - border[i])[0];
  if (border[bg] > 0.25 * 2 * (w + h)) order = [bg, ...order.filter((i) => i !== bg)];
  if (opts.binary) order = [0, 1];
  const rank = new Int16Array(256).fill(-1);
  order.forEach((c, r) => (rank[c] = r));

  const W = w + 2, H = h + 2;
  const field = new Float32Array(W * H);
  const geomField = mix.geom ? new Float32Array(W * H) : undefined;
  const own = new Float32Array(w * h);
  const tracer = new ContourTracer(W, H);
  const fit: FitOptions = {
    cornerAngle: opts.cornerAngle,
    fitTolerance: opts.fitTolerance,
    lineTolerance: Math.max(0.12, opts.fitTolerance * 0.9),
    snapAngle: opts.snapAngle ?? 1.5,
    fairing: opts.fairing,
    optimal: opts.optimal,
    fairTolerance: opts.fairTolerance,
    symmetry: opts.symmetry,
    scale: opts.scale,
    debug: opts.debug,
  };

  const shapes: Shape[] = [];
  for (let r = 0; r < order.length; r++) {
    const layer = order[r];
    if (opts.binary && layer === 0) continue; // paper is not drawn
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        const a = mix.a[p], b = mix.b[p], c = mix.cov[p];
        const op = mix.alpha ? mix.alpha[p] : 1;
        const mine = ((a === layer ? c : 0) + (b === layer && b !== a ? 1 - c : 0)) * op;
        own[p] = mine;
        let v: number;
        if (opts.stacking === 'stacked') {
          v = ((rank[a] >= r ? c : 0) + (b !== a && rank[b] >= r ? 1 - c : 0)) * op;
        } else {
          v = mine;
        }
        field[(y + 1) * W + x + 1] = v;
        // Binary mode only (one ink layer): unboosted ink coverage for edge geometry.
        if (geomField) geomField[(y + 1) * W + x + 1] = mix.geom![p] * op;
      }
    }

    lap('field');
    const contours = tracer
      .trace(field)
      .map((c) => {
        const points = refineEdges(c.points, field, W, H, geomField);
        return { points, area: signedArea(points) };
      })
      .filter((c) => Math.abs(c.area) >= opts.minArea);
    const outers = contours.filter((c) => c.area > 0).sort((p, q) => q.area - p.area);
    const holes = contours.filter((c) => c.area < 0);

    lap('contours+refine');
    const kept = opts.stacking === 'stacked' ? outers.filter((c) => ownsPixels(c, own, w, h)) : outers;
    const groups = new Map<Contour, Contour[]>(kept.map((c) => [c, []]));
    for (const hole of holes) {
      const hb = bounds(hole.points);
      let best: Contour | null = null;
      for (const outer of outers) {
        if (outer.area < -hole.area) continue;
        const ob = bounds(outer.points);
        if (hb[0] < ob[0] || hb[1] < ob[1] || hb[2] > ob[2] || hb[3] > ob[3]) continue;
        const [hx, hy] = hole.points[0];
        if (!pointInPolygon(hx, hy, outer.points)) continue;
        if (!best || outer.area < best.area) best = outer;
      }
      if (best) groups.get(best)?.push(hole);
    }

    const fill = rgbToHex(...palette.colors[layer].rgb);
    lap('components');
    for (const [outer, inner] of groups) {
      const segs: Seg[] = [...fitContour(outer.points, fit)];
      for (const hole of inner) segs.push(...fitContour(hole.points, fit));
      if (segs.length) shapes.push({ fill, segs });
    }
  }
  lap('fit');
  return { width: w, height: h, shapes };
}

/**
 * In stacked mode a layer's field also includes every layer above it. Islands
 * made only of higher layers are hidden under them anyway, so they are dropped.
 */
function ownsPixels(c: Contour, own: Float32Array, w: number, h: number): boolean {
  const [x0, y0, x1, y1] = bounds(c.points);
  const xs = Math.max(0, Math.floor(x0)), xe = Math.min(w - 1, Math.ceil(x1));
  const ys = Math.max(0, Math.floor(y0)), ye = Math.min(h - 1, Math.ceil(y1));
  const span = (xe - xs + 1) * (ye - ys + 1);
  const stride = Math.max(1, Math.floor(Math.sqrt(span / 4000)));
  for (let y = ys; y <= ye; y += stride) {
    for (let x = xs; x <= xe; x += stride) {
      if (own[y * w + x] >= 0.5 && pointInPolygon(x + 0.5, y + 0.5, c.points)) return true;
    }
  }
  // Thin features can slip between strided samples: check every owned pixel along the outline.
  for (const [px, py] of c.points) {
    const x = Math.min(w - 1, Math.max(0, Math.floor(px))), y = Math.min(h - 1, Math.max(0, Math.floor(py)));
    if (own[y * w + x] >= 0.5) return true;
  }
  return false;
}
