// Turns a closed sub-pixel contour into clean geometry:
//   1. corner detection (turn angle + straightness of the two arms),
//   2. corner reconstruction: anti-aliasing chamfers corners, so straight arms
//      are extended past the blurred tip to their true intersection,
//   3. per-piece fitting: line → circular arc → least-squares cubic Béziers
//      (Schneider's algorithm with Newton reparameterisation),
//   4. fairing: near-axis lines snap to exact angles; corner-free loops that
//      match an ellipse or circle become one.

import type { Seg } from '../vector.ts';
import type { Pt } from './contours.ts';
import { signedArea } from './contours.ts';
import { symmetrize, type Mirror, type SymmetryOptions } from './symmetry.ts';

export interface FitOptions {
  /** Minimum turn (degrees) for a corner between two straight arms. */
  cornerAngle: number;
  /** Max distance (px) between fitted curves and the contour. */
  fitTolerance: number;
  /** Max distance (px) for a run of points to count as a straight line. */
  lineTolerance: number;
  /** Lines within this many degrees of 0/45/90° are snapped exactly; 0 = off. */
  snapAngle: number;
  /** Taubin fairing iterations applied before fitting (default 6). */
  fairing?: number;
  /** Fewest-node dynamic-programming fit (default true); false = greedy Schneider. */
  optimal?: boolean;
  /** Tolerance for stretches recognised as rasteriser facets of one curve (default 0.5 px). */
  fairTolerance?: number;
  /**
   * Image pixels per pixel of the original artwork (> 1 when AI-enhanced).
   * Shape-size judgements (how long a straight line or a corner arm must be)
   * scale with it; blur-size ones (how quickly a corner turns) do not. Default 1.
   */
  scale?: number;
  /** Mirror-symmetry recovery before fitting (see symmetry.ts); omitted = off. */
  symmetry?: SymmetryOptions;
  /** Optional hook receiving each corner candidate's decision (diagnostics only). */
  debug?: (info: Record<string, unknown>) => void;
}

type V = [number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1]];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1]];
const mul = (a: V, s: number): V => [a[0] * s, a[1] * s];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1];
const cross = (a: V, b: V) => a[0] * b[1] - a[1] * b[0];
const len = (a: V) => Math.hypot(a[0], a[1]);
const norm = (a: V): V => {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l] : [1, 0];
};
const DEG = Math.PI / 180;

type Cubic = [V, V, V, V];

interface Line {
  c: V;
  d: V;
  /** Max and RMS distance of the points from the line. */
  dev: number;
  rms: number;
  n: number;
}

/**
 * Real rasterisers quantise coverage (Chrome's canvas to 4 sub-scanlines), so
 * even perfect edges carry noise after unmixing, and JPEGs carry more. Straightness
 * is judged on RMS against the larger of the tolerance and the contour's own
 * measured noise level; the max deviation only guards against genuine bends.
 */
function isStraight(l: Line | null, tol: number, noise: number): l is Line {
  return !!l && l.n >= 2 && l.rms <= Math.max(tol * 0.6, noise * 1.6) && l.dev <= Math.max(tol * 2.4, noise * 4.5);
}

/**
 * Noise level (σ, px) of a contour: each point's offset from the chord of its
 * two neighbours is ~1.22σ for iid normal noise on a locally straight edge,
 * and the median of its absolute value is 0.674 × that.
 */
function estimateNoise(pts: V[]): number {
  const n = pts.length;
  if (n < 8) return 0;
  const offs: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], p = pts[i], b = pts[(i + 1) % n];
    const ab = sub(b, a), l = len(ab);
    if (l > 1e-9) offs.push(Math.abs(cross(ab, sub(p, a))) / l);
  }
  offs.sort((x, y) => x - y);
  return offs[offs.length >> 1] / (0.674 * 1.22);
}

/**
 * Total least-squares line through points, `d` oriented first → last. One
 * trimming pass drops outliers (e.g. points the edge refiner could not correct).
 */
function fitLine(pts: V[]): Line | null {
  const first = fitLineOnce(pts);
  if (!first || first.dev <= 0.06 || pts.length < 5) return first;
  const res = pts.map((p) => Math.abs(cross(first.d, sub(p, first.c))));
  const median = [...res].sort((a, b) => a - b)[Math.floor(res.length / 2)];
  const keep = pts.filter((_, i) => res[i] <= Math.max(0.06, 3 * median));
  if (keep.length < Math.max(3, pts.length * 0.6)) return first;
  const second = fitLineOnce(keep);
  return second && second.dev < first.dev ? second : first;
}

function fitLineOnce(pts: V[]): Line | null {
  if (pts.length < 2) return null;
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; }
  cx /= pts.length;
  cy /= pts.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) {
    const dx = p[0] - cx, dy = p[1] - cy;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let d: V = [Math.cos(angle), Math.sin(angle)];
  if (dot(d, sub(pts[pts.length - 1], pts[0])) < 0) d = mul(d, -1);
  let dev = 0, sq = 0;
  for (const p of pts) {
    const e = Math.abs(cross(d, sub(p, [cx, cy])));
    dev = Math.max(dev, e);
    sq += e * e;
  }
  return { c: [cx, cy], d, dev, rms: Math.sqrt(sq / pts.length), n: pts.length };
}

function snapDirection(d: V, snapDeg: number): V {
  if (snapDeg <= 0) return d;
  const a = Math.atan2(d[1], d[0]);
  const step = Math.PI / 4;
  const snapped = Math.round(a / step) * step;
  return Math.abs(a - snapped) <= snapDeg * DEG ? [Math.cos(snapped), Math.sin(snapped)] : d;
}

function intersect(p1: V, d1: V, p2: V, d2: V): V | null {
  const den = cross(d1, d2);
  if (Math.abs(den) < Math.sin(8 * DEG)) return null;
  const t = cross(sub(p2, p1), d2) / den;
  return add(p1, mul(d1, t));
}

function distToSegment(p: V, a: V, b: V): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < 1e-12) return len(sub(p, a));
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return len(sub(p, add(a, mul(ab, t))));
}

// ---------------------------------------------------------------------------
// Schneider curve fitting

function bez(c: Cubic, t: number): V {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
  return [a * c[0][0] + b * c[1][0] + d * c[2][0] + e * c[3][0], a * c[0][1] + b * c[1][1] + d * c[2][1] + e * c[3][1]];
}

function bezD1(c: Cubic, t: number): V {
  const u = 1 - t;
  return [
    3 * (u * u * (c[1][0] - c[0][0]) + 2 * u * t * (c[2][0] - c[1][0]) + t * t * (c[3][0] - c[2][0])),
    3 * (u * u * (c[1][1] - c[0][1]) + 2 * u * t * (c[2][1] - c[1][1]) + t * t * (c[3][1] - c[2][1])),
  ];
}

function bezD2(c: Cubic, t: number): V {
  const u = 1 - t;
  return [
    6 * (u * (c[2][0] - 2 * c[1][0] + c[0][0]) + t * (c[3][0] - 2 * c[2][0] + c[1][0])),
    6 * (u * (c[2][1] - 2 * c[1][1] + c[0][1]) + t * (c[3][1] - 2 * c[2][1] + c[1][1])),
  ];
}

function chordParams(d: V[], first: number, last: number): number[] {
  const u = [0];
  for (let i = first + 1; i <= last; i++) u.push(u[u.length - 1] + len(sub(d[i], d[i - 1])));
  const total = u[u.length - 1] || 1;
  return u.map((v) => v / total);
}

function generateBezier(d: V[], first: number, last: number, u: number[], t1: V, t2: V): Cubic {
  const p0 = d[first], p3 = d[last];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < u.length; i++) {
    const t = u[i], s = 1 - t;
    const b0 = s * s * s, b1 = 3 * s * s * t, b2 = 3 * s * t * t, b3 = t * t * t;
    const a1 = mul(t1, b1), a2 = mul(t2, b2);
    c00 += dot(a1, a1);
    c01 += dot(a1, a2);
    c11 += dot(a2, a2);
    const tmp = sub(d[first + i], add(mul(p0, b0 + b1), mul(p3, b2 + b3)));
    x0 += dot(a1, tmp);
    x1 += dot(a2, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  const seg = len(sub(p3, p0));
  let al = 0, ar = 0;
  if (Math.abs(det) > 1e-12) {
    al = (x0 * c11 - x1 * c01) / det;
    ar = (c00 * x1 - c01 * x0) / det;
  }
  const eps = 1e-6 * seg;
  if (al < eps || ar < eps || al > seg * 2 || ar > seg * 2) {
    al = ar = seg / 3;
  }
  return [p0, add(p0, mul(t1, al)), add(p3, mul(t2, ar)), p3];
}

function reparameterize(d: V[], first: number, c: Cubic, u: number[]): number[] {
  return u.map((t, i) => {
    const p = d[first + i];
    const q = bez(c, t), q1 = bezD1(c, t), q2 = bezD2(c, t);
    const diff = sub(q, p);
    const num = dot(diff, q1);
    const den = dot(q1, q1) + dot(diff, q2);
    if (Math.abs(den) < 1e-12) return t;
    return Math.max(0, Math.min(1, t - num / den));
  });
}

function maxError(d: V[], first: number, c: Cubic, u: number[]): [number, number] {
  let worst = 0, at = first + Math.floor(u.length / 2);
  for (let i = 1; i < u.length - 1; i++) {
    const e = len(sub(bez(c, u[i]), d[first + i]));
    if (e > worst) { worst = e; at = first + i; }
  }
  return [worst, at];
}

function centreTangent(d: V[], i: number, first: number, last: number): V {
  const a = d[Math.max(first, i - 2)], b = d[Math.min(last, i + 2)];
  return norm(sub(a, b));
}

function fitCubic(d: V[], first: number, last: number, t1: V, t2: V, tol: number, out: Cubic[], depth = 0) {
  const n = last - first + 1;
  if (n === 2 || depth > 24) {
    const dist = len(sub(d[last], d[first])) / 3;
    out.push([d[first], add(d[first], mul(t1, dist)), add(d[last], mul(t2, dist)), d[last]]);
    return;
  }
  let u = chordParams(d, first, last);
  let c = generateBezier(d, first, last, u, t1, t2);
  let [err, split] = maxError(d, first, c, u);
  // Spans under ~2.5 px of path are below what anti-aliased input can resolve;
  // splitting them further only fits noise (the sawtooth on long edges).
  let span = 0;
  for (let i = first + 1; i <= last && span < 2.5; i++) span += len(sub(d[i], d[i - 1]));
  if (err <= tol || span < 2.5) {
    out.push(c);
    return;
  }
  if (err <= tol * 6) {
    for (let k = 0; k < 12; k++) {
      u = reparameterize(d, first, c, u);
      c = generateBezier(d, first, last, u, t1, t2);
      [err, split] = maxError(d, first, c, u);
      if (err <= tol) {
        out.push(c);
        return;
      }
    }
  }
  split = Math.max(first + 1, Math.min(last - 1, split));
  const tc = centreTangent(d, split, first, last);
  fitCubic(d, first, split, t1, tc, tol, out, depth + 1);
  fitCubic(d, split, last, mul(tc, -1), t2, tol, out, depth + 1);
}

// ---------------------------------------------------------------------------
// Primitive tests

/** Circular arc from a to b through the points; null when it doesn't fit. */
function fitArc(pts: V[], tol: number): Cubic[] | null {
  const a = pts[0], b = pts[pts.length - 1];
  const chord = sub(b, a);
  const h = len(chord) / 2;
  if (h < 0.5 || pts.length < 4) return null;
  const m = mul(add(a, b), 0.5);
  const nrm: V = norm([-chord[1], chord[0]]);
  // Centre lies on the bisector m + s·n; minimise radial error over s.
  const cost = (s: number) => {
    const c = add(m, mul(nrm, s));
    const r = Math.hypot(h, s);
    let e = 0;
    for (const p of pts) e += (len(sub(p, c)) - r) ** 2;
    return e;
  };
  // Seed with the circle through a, b and the middle point.
  const mid = pts[Math.floor(pts.length / 2)];
  const toMid = sub(mid, m);
  const sag = dot(toMid, nrm);
  if (Math.abs(sag) < 0.15) return null; // effectively straight
  let s = (dot(toMid, toMid) - h * h) / (2 * sag);
  let lo = s - Math.max(2, Math.abs(s) * 0.5), hi = s + Math.max(2, Math.abs(s) * 0.5);
  for (let i = 0; i < 60; i++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (cost(m1) < cost(m2)) hi = m2;
    else lo = m1;
  }
  s = (lo + hi) / 2;
  const c = add(m, mul(nrm, s));
  const r = Math.hypot(h, s);
  if (r > 4000) return null;
  let worst = 0, sq = 0;
  for (const p of pts) {
    const e = Math.abs(len(sub(p, c)) - r);
    worst = Math.max(worst, e);
    sq += e * e;
  }
  if (worst > tol * 2 || Math.sqrt(sq / pts.length) > tol * 0.6) return null;

  const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
  const am = Math.atan2(mid[1] - c[1], mid[0] - c[0]);
  const a1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
  const wrap = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  // Sweep direction that passes through the middle point.
  const ccw = wrap(am - a0) < wrap(a1 - a0);
  const sweep = ccw ? wrap(a1 - a0) : -wrap(a0 - a1);
  if (Math.abs(sweep) < 15 * DEG) return null;
  return arcToCubics(c, r, r, 0, a0, sweep, a, b);
}

function arcToCubics(c: V, rx: number, ry: number, rot: number, start: number, sweep: number, from?: V, to?: V): Cubic[] {
  const parts = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
  const step = sweep / parts;
  const k = (4 / 3) * Math.tan(step / 4);
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const at = (t: number): V => {
    const x = rx * Math.cos(t), y = ry * Math.sin(t);
    return [c[0] + x * cr - y * sr, c[1] + x * sr + y * cr];
  };
  const deriv = (t: number): V => {
    const x = -rx * Math.sin(t), y = ry * Math.cos(t);
    return [x * cr - y * sr, x * sr + y * cr];
  };
  const out: Cubic[] = [];
  for (let i = 0; i < parts; i++) {
    const t0 = start + i * step, t1 = t0 + step;
    const p0 = i === 0 && from ? from : at(t0);
    const p3 = i === parts - 1 && to ? to : at(t1);
    out.push([p0, add(p0, mul(deriv(t0), k)), sub(p3, mul(deriv(t1), k)), p3]);
  }
  return out;
}

/**
 * Ellipse (or circle) matching a loop, from its area moments. `relTol` lets the
 * tolerance grow with size (a fraction of the minor radius): a 1% wobble on a
 * 40 px ring is invisible, so it should still read as a circle.
 */
function fitEllipse(pts: V[], tol: number, relTol = 0): Cubic[] | null {
  let A = 0, cx = 0, cy = 0;
  const n = pts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const cr = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    A += cr;
    cx += (pts[j][0] + pts[i][0]) * cr;
    cy += (pts[j][1] + pts[i][1]) * cr;
  }
  A /= 2;
  if (Math.abs(A) < 3) return null;
  cx /= 6 * A;
  cy /= 6 * A;
  let ixx = 0, iyy = 0, ixy = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xj = pts[j][0] - cx, yj = pts[j][1] - cy, xi = pts[i][0] - cx, yi = pts[i][1] - cy;
    const cr = xj * yi - xi * yj;
    ixx += (yj * yj + yj * yi + yi * yi) * cr;
    iyy += (xj * xj + xj * xi + xi * xi) * cr;
    ixy += (xj * yi + 2 * xj * yj + 2 * xi * yi + xi * yj) * cr;
  }
  // Covariance of the filled region.
  const sxx = iyy / (12 * A), syy = ixx / (12 * A), sxy = ixy / (24 * A);
  const tr = sxx + syy, det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
  if (l2 <= 0) return null;
  let rx = 2 * Math.sqrt(l1), ry = 2 * Math.sqrt(l2);
  let rot = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  if (rx - ry < Math.max(0.15, 0.02 * rx)) {
    rx = ry = (rx + ry) / 2;
    rot = 0;
  }
  if (ry < 1) return null;
  const cr = Math.cos(-rot), sr = Math.sin(-rot);
  const t = Math.max(tol, relTol * ry);
  let sq = 0;
  for (const p of pts) {
    const x = (p[0] - cx) * cr - (p[1] - cy) * sr, y = (p[0] - cx) * sr + (p[1] - cy) * cr;
    const rho = Math.hypot(x / rx, y / ry);
    if (rho < 1e-9) return null;
    const e = Math.abs(rho - 1) * (Math.hypot(x, y) / rho);
    if (e > t * 2.4) return null; // a real bump, not quantisation noise
    sq += e * e;
  }
  if (Math.sqrt(sq / pts.length) > t * 0.6) return null;
  // Start at the contour's first point's angle and follow its orientation.
  const p0 = pts[0];
  const x0 = (p0[0] - cx) * cr - (p0[1] - cy) * sr, y0 = (p0[0] - cx) * sr + (p0[1] - cy) * cr;
  const start = Math.atan2(y0 / ry, x0 / rx);
  const sweep = A > 0 ? 2 * Math.PI : -2 * Math.PI;
  return arcToCubics([cx, cy], rx, ry, rot, start, sweep);
}

// ---------------------------------------------------------------------------
// Contour fitting

interface Corner {
  i: number;
  p: V;
  /** Direction of travel arriving at / leaving the corner. */
  tin: V;
  tout: V;
  /** Radius around the tip where contour points are blur-biased and ignored. */
  gap: number;
}

export function fitContour(raw: Pt[], opts: FitOptions): Seg[] {
  const pts: V[] = [];
  for (const p of raw) {
    if (!pts.length || len(sub(p, pts[pts.length - 1])) > 0.02) pts.push([p[0], p[1]]);
  }
  while (pts.length > 1 && len(sub(pts[0], pts[pts.length - 1])) <= 0.02) pts.pop();
  let mirrors: Mirror[] = [];
  if (opts.symmetry) {
    const sym = symmetrize(pts, opts.symmetry);
    for (let i = 0; i < pts.length; i++) pts[i] = sym.pts[i];
    mirrors = sym.mirrors;
  }
  const n = pts.length;
  if (n < 6) return polygon(pts);

  const S = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) S[i] = S[i - 1] + len(sub(pts[i % n], pts[i - 1]));
  const L = S[n];
  const pointAt = (s: number): V => {
    s = ((s % L) + L) % L;
    let lo = 0, hi = n;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (S[mid] <= s) lo = mid;
      else hi = mid;
    }
    const seg = S[lo + 1] - S[lo];
    const t = seg > 0 ? (s - S[lo]) / seg : 0;
    const a = pts[lo], b = pts[(lo + 1) % n];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };
  /** Points whose arc distance from index i (forward when dir=1) lies in [from, to]. */
  const arm = (i: number, dir: 1 | -1, from: number, to: number): V[] => {
    const out: V[] = [];
    for (let k = 1; k < n; k++) {
      const j = (i + dir * k + n) % n;
      const ds = dir > 0 ? (S[j] - S[i] + L) % L : (S[i] - S[j] + L) % L;
      if (ds > to) break;
      if (ds >= from) out.push(pts[j]);
    }
    return dir > 0 ? out : out.reverse();
  };

  // 0. A human sees a circle or ellipse regardless of a stray noise "corner":
  //    accept a perfect ellipse when the contour fits one within ~1% of its size.
  if (n >= 12) {
    const ellipse = fitEllipse(pts, opts.fitTolerance * 1.25, 0.02);
    if (ellipse) return fromCubics(ellipse);
  }

  // 1. Corner candidates: local maxima of the turn angle at a small arc radius.
  const noise = estimateNoise(pts);
  // Corner arms are judged over a length of the original artwork, so on an
  // enhanced image a few pixels of a small dome do not pass for a straight arm.
  const armScale = Math.max(1, opts.scale ?? 1);
  const r = Math.min(2.5, L / 8);
  const theta = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v1 = sub(pts[i], pointAt(S[i] - r)), v2 = sub(pointAt(S[i] + r), pts[i]);
    theta[i] = Math.atan2(Math.abs(cross(v1, v2)), dot(v1, v2));
  }
  const minTurn = opts.cornerAngle * DEG * 0.6;
  const candidates: number[] = [];
  for (let i = 0; i < n; i++) {
    if (theta[i] < minTurn) continue;
    let isMax = true;
    for (let k = 1; k < n && isMax; k++) {
      const jf = (i + k) % n, jb = (i - k + n) % n;
      const df = (S[jf] - S[i] + L) % L, db = (S[i] - S[jb] + L) % L;
      if (df > r && db > r) break;
      if (df <= r && (theta[jf] > theta[i] || (theta[jf] === theta[i] && jf < i))) isMax = false;
      if (db <= r && (theta[jb] > theta[i] || (theta[jb] === theta[i] && jb < i))) isMax = false;
    }
    if (isMax) candidates.push(i);
  }

  // A corner turns all at once; a tight curve flowing into a line turns
  // gradually. Compare the turn measured at half the radius: for a corner it
  // stays nearly the same, for a circular arc it roughly halves.
  const concentrated = (i: number) => {
    const rs = r / 2;
    const v1 = sub(pts[i], pointAt(S[i] - rs)), v2 = sub(pointAt(S[i] + rs), pts[i]);
    const small = Math.atan2(Math.abs(cross(v1, v2)), dot(v1, v2));
    return small >= theta[i] * 0.68;
  };
  /**
   * Tapered tip at candidate i: rebuilt apex and the directions into/out of it,
   * or null for an end cap. Decided at a scale past the blurred end (where a
   * faint tip can read as a constant-width stub): a taper's sides, fitted 5–18 px
   * back, converge to a point just ahead of the visible end, while a cap's sides
   * run parallel. Curvy sides fall back to extrapolating the width to zero.
   */
  const taperTip = (i: number, span: number): { p: V; tin: V; tout: V } | null => {
    if (span < 12) return null;
    const reach = Math.min(18, span - 1);
    const side = (d: number): [V, V] => [pointAt(S[i] - d), pointAt(S[i] + d)];
    const ahead = (x: V) => len(sub(x, pts[i]));
    const back = fitLine(arm(i, -1, 5, reach));
    const fwd = fitLine(arm(i, 1, 5, reach));
    let p: V | null = null;
    if (back && fwd && back.n >= 4 && fwd.n >= 4 && back.rms < 0.25 && fwd.rms < 0.25) {
      const angle = Math.acos(Math.max(-1, Math.min(1, -dot(back.d, fwd.d))));
      const x = intersect(back.c, back.d, fwd.c, fwd.d);
      // Converging sides (3°–60° apart) meeting just past the visible end.
      if (x && angle > 3 * DEG && angle < 60 * DEG && dot(sub(x, pts[i]), back.d) > -0.5 && ahead(x) <= 6) p = x;
      else return null;
    } else {
      const [a8, b8] = side(8), [a14, b14] = side(14);
      const w8 = len(sub(a8, b8)), w14 = len(sub(a14, b14));
      if (!(w14 - w8 > 0.3 && w14 < 14)) return null;
      const m8 = mul(add(a8, b8), 0.5), m14 = mul(add(a14, b14), 0.5);
      const along = len(sub(m8, m14));
      const ext = (w8 * along) / (w14 - w8);
      if (!(along > 1e-6) || ext > 14) return null;
      p = add(m8, mul(norm(sub(m8, m14)), ext));
      if (ahead(p) > 6) return null;
    }
    const [a6, b6] = side(6);
    return { p, tin: norm(sub(p, a6)), tout: norm(sub(b6, p)) };
  };

  // How spread out a turn is: arc length over which the middle 70% of the total
  // tangent change happens. A corner turns within ~1 px even when anti-aliased;
  // a rounded bend (a bird's wing hump, radius 4–7 px) spreads over several.
  // The window stops halfway to the neighbouring candidates: on a tiny star
  // the next vertex is only ~4 px away and would otherwise count as spread.
  const turnSpread = (i: number, backSpan: number, fwdSpan: number) => {
    const step = 0.5;
    const from = -Math.max(1.5, Math.min(8, backSpan / 2)), to = Math.max(1.5, Math.min(8, fwdSpan / 2));
    const dirs: number[] = [];
    for (let d = from; d <= to; d += step) {
      const a = pointAt(S[i] + d - 1), b = pointAt(S[i] + d + 1);
      dirs.push(Math.atan2(b[1] - a[1], b[0] - a[0]));
    }
    const cum: number[] = [0];
    for (let k = 1; k < dirs.length; k++) {
      let dd = dirs[k] - dirs[k - 1];
      while (dd > Math.PI) dd -= 2 * Math.PI;
      while (dd < -Math.PI) dd += 2 * Math.PI;
      cum.push(cum[k - 1] + dd);
    }
    const total = cum[cum.length - 1];
    if (Math.abs(total) < 1e-6) return Infinity;
    const at = (f: number) => cum.findIndex((c) => c / total >= f);
    const k15 = at(0.15), k85 = at(0.85);
    return k15 < 0 || k85 < 0 ? Infinity : (k85 - k15) * step;
  };

  // Model selection on the same arm points (outside the blurred tip): two
  // straight lines meeting at a corner vs one circular arc. The bottom of a U
  // or the bowl of a P fits the arc far better; a corner, even an obtuse
  // blurred one like a star's inner vertex, fits the two lines far better.
  // Both models use the same fixed 4 px windows, not arms cut short by a
  // neighbouring (weak) candidate, which would let two lines fit anything.
  const onSmoothCurve = (i: number, gap: number) => {
    const backPts = arm(i, -1, gap, gap + 4), fwdPts = arm(i, 1, gap, gap + 4);
    const back = fitLineOnce(backPts), fwd = fitLineOnce(fwdPts);
    if (!back || !fwd || back.n < 3 || fwd.n < 3) return false;
    const local = [...backPts, ...fwdPts];
    const c = kasaCircle(local);
    if (!c || c.r < 1.5 || c.r > 400) return false;
    let sq = 0;
    for (const p of local) sq += (len(sub(p, c.c)) - c.r) ** 2;
    const circleRms = Math.sqrt(sq / local.length);
    const lineRms = Math.sqrt((back.rms ** 2 * back.n + fwd.rms ** 2 * fwd.n) / (back.n + fwd.n));
    opts.debug?.({ at: pts[i], circleRms, lineRms, r: c.r, noise });
    return circleRms <= Math.max(0.08, noise * 1.2) && circleRms < lineRms * 0.85;
  };

  // 2. Confirm corners by the straightness of their arms, and reconstruct the tip.
  //    Near a sharp tip the shape is thinner than the anti-aliasing blur, so the
  //    contour there is pulled inward. Arms are measured beyond that zone
  //    (≈1.25 px / tan(interior/2): ~1.3 px for 90°, ~3.9 px for a 36° star
  //    point) and extended back to the true tip.
  const corners: Corner[] = [];
  candidates.forEach((i, ci) => {
    const prev = candidates[(ci - 1 + candidates.length) % candidates.length];
    const next = candidates[(ci + 1) % candidates.length];
    const backSpan = candidates.length > 1 ? (S[i] - S[prev] + L) % L : L / 2;
    const fwdSpan = candidates.length > 1 ? (S[next] - S[i] + L) % L : L / 2;
    const measure = (gap: number, reach: number) => {
      const backArm = fitLine(arm(i, -1, gap, Math.max(gap + 0.5, Math.min(gap + reach, backSpan - 1))));
      const fwdArm = fitLine(arm(i, 1, gap, Math.max(gap + 0.5, Math.min(gap + reach, fwdSpan - 1))));
      const straightB = isStraight(backArm, opts.lineTolerance, noise);
      const straightF = isStraight(fwdArm, opts.lineTolerance, noise);
      const nearB = fitLine(arm(i, -1, Math.min(gap, 2) * 0.5, Math.min(gap, 2) * 0.5 + 2.5)) ?? backArm;
      const nearF = fitLine(arm(i, 1, Math.min(gap, 2) * 0.5, Math.min(gap, 2) * 0.5 + 2.5)) ?? fwdArm;
      let tin: V = straightB ? backArm!.d : nearB ? nearB.d : norm(sub(pts[i], pointAt(S[i] - r)));
      let tout: V = straightF ? fwdArm!.d : nearF ? nearF.d : norm(sub(pointAt(S[i] + r), pts[i]));
      if (straightB) tin = snapDirection(tin, opts.snapAngle);
      if (straightF) tout = snapDirection(tout, opts.snapAngle);
      const turn = Math.atan2(Math.abs(cross(tin, tout)), dot(tin, tout));
      return { backArm, fwdArm, straightB, straightF, nearB, nearF, tin, tout, turn };
    };
    let gap = 1.0;
    let m = measure(gap, 5 * armScale);
    if (m.turn > 95 * DEG) {
      const interior = Math.PI - m.turn;
      gap = Math.min(6, Math.max(1, 1.25 / Math.tan(Math.max(0.15, interior) / 2)));
      if (gap > 1.2) {
        const wide = measure(gap, 8 * armScale);
        if (wide.straightB && wide.straightF) m = wide;
        else gap = 1.0;
      }
    }
    const { backArm, fwdArm, straightB, straightF, nearB, nearF, tin, tout, turn } = m;

    // A ~180° turn is either a stroke's end cap (sides stay parallel: width
    // constant) or a tapered tip (sides converge: width keeps shrinking towards
    // the end, as in pen and brush strokes). Blur blunts a taper into a round
    // end; its true point is rebuilt by extrapolating the width to zero along
    // the stroke's centreline.
    if (turn >= 150 * DEG) {
      const tip = taperTip(i, Math.min(backSpan, fwdSpan));
      if (tip) {
        const reach = len(sub(tip.p, pts[i]));
        opts.debug?.({ at: pts[i], taper: true, reach });
        corners.push({ i, p: tip.p, tin: tip.tin, tout: tip.tout, gap: reach + 1.5 });
        return;
      }
    }

    const isCorner =
      ((straightB && straightF && turn >= opts.cornerAngle * DEG) ||
        ((((straightB || straightF) && theta[i] >= (opts.cornerAngle + 20) * DEG) || theta[i] >= (opts.cornerAngle + 45) * DEG) &&
          concentrated(i))) &&
      // A ~180° turn between near-parallel sides is a stroke's end cap, not a
      // corner: the sides never meet, so it is fitted as a smooth curve.
      turn < 150 * DEG &&
      !onSmoothCurve(i, gap) &&
      // Real corners turn within ~2 px (star points 1–2, sawtooth 1.5–2);
      // rounded bends like a bird's wing hump spread over 3.5 px or more.
      turnSpread(i, backSpan, fwdSpan) <= 2.8;
    opts.debug?.({
      at: pts[i], theta: theta[i] / DEG, turn: turn / DEG, gap, isCorner, straightB, straightF, spread: turnSpread(i, backSpan, fwdSpan), noise,
      armB: backArm && { rms: backArm.rms, dev: backArm.dev, n: backArm.n },
      armF: fwdArm && { rms: fwdArm.rms, dev: fwdArm.dev, n: fwdArm.n },
    });
    if (!isCorner) return;

    let p: V = pts[i];
    const lineB = straightB ? backArm! : nearB;
    const lineF = straightF ? fwdArm! : nearF;
    if (lineB && lineF) {
      const x = intersect(lineB.c, tin, lineF.c, tout);
      // Blur cuts sharp tips further back: a 36° star point loses ~1.6 px.
      const interior = Math.PI - turn;
      const reach = Math.min(6, 1.25 / Math.max(0.2, Math.sin(interior / 2)) + 0.5);
      const limit = straightB && straightF ? reach : Math.min(reach, 2);
      if (x && len(sub(x, pts[i])) <= limit) p = x;
    }
    corners.push({ i, p, tin, tout, gap: p === pts[i] ? 1 : Math.max(1, gap) });
  });

  if (corners.length === 0) {
    const ellipse = fitEllipse(pts, opts.fitTolerance * 1.25);
    if (ellipse) return fromCubics(ellipse);
    return smoothLoop(pts, opts.fitTolerance, opts, noise);
  }

  // 2b. Mirror pairs: corners that mirror each other on a symmetric stretch
  //     become exact mirror images, and corners on an axis sit on it.
  const nc = corners.length;
  const partner = new Array<number>(nc).fill(-1);
  const via = new Array<Mirror | null>(nc).fill(null);
  const arcOf = (f: number) => {
    const k = Math.floor(f), t = f - k;
    return S[((k % n) + n) % n] + (S[(((k % n) + n) % n) + 1] - S[((k % n) + n) % n]) * t;
  };
  const arcGap = (s1: number, s2: number) => {
    const d = Math.abs(s1 - s2) % L;
    return Math.min(d, L - d);
  };
  for (const m of mirrors) {
    const R = (p: V): V => reflectPoint(p, m.c, m.u);
    const RD = (d: V): V => reflectDir(d, m.u);
    for (let a = 0; a < nc; a++) {
      if (partner[a] >= 0) continue;
      const j = m.partner(corners[a].i);
      if (j === null) continue;
      const A = corners[a];
      if (arcGap(arcOf(j), S[A.i]) <= 1.5) {
        // On the axis: the tip lies on it and its two sides mirror each other.
        const t = dot(sub(A.p, m.c), m.u);
        A.p = add(m.c, mul(m.u, t));
        A.tin = norm(add(A.tin, mul(RD(A.tout), -1)));
        A.tout = mul(RD(A.tin), -1);
        partner[a] = a;
        via[a] = m;
        continue;
      }
      let b = -1, best = 2.5 * armScale;
      for (let q = 0; q < nc; q++) {
        if (q === a || partner[q] >= 0) continue;
        const d = arcGap(S[corners[q].i], arcOf(j));
        if (d <= best) { best = d; b = q; }
      }
      if (b < 0) continue;
      const B = corners[b];
      const p = mul(add(A.p, R(B.p)), 0.5);
      const tin = norm(add(A.tin, mul(RD(B.tout), -1)));
      const tout = norm(add(A.tout, mul(RD(B.tin), -1)));
      A.p = p;
      A.tin = tin;
      A.tout = tout;
      B.p = R(p);
      B.tin = mul(RD(tout), -1);
      B.tout = mul(RD(tin), -1);
      A.gap = B.gap = Math.max(A.gap, B.gap);
      partner[a] = b;
      partner[b] = a;
      via[a] = via[b] = m;
    }
  }

  // 3. Fit each piece between consecutive corners. On a mirror, a piece that
  //    crosses the axis is fitted up to the axis and completed by its mirror
  //    image, and a piece whose twin lies on the other side is fitted once and
  //    copied, so both halves come out identical.
  const pieceAt = (k: number): V[] => {
    const a = corners[k], b = corners[(k + 1) % nc];
    const piece: V[] = [a.p];
    const count = (b.i - a.i + n) % n || n;
    for (let s = 1; s < count; s++) {
      const p = pts[(a.i + s) % n];
      // Drop the anti-aliasing chamfer next to reconstructed corners.
      if (len(sub(p, a.p)) < a.gap || len(sub(p, b.p)) < b.gap) continue;
      piece.push(p);
    }
    piece.push(b.p);
    return piece;
  };
  const fitted = new Array<Seg[] | null>(nc).fill(null);
  for (let k = 0; k < nc; k++) {
    if (fitted[k]) continue;
    const a = corners[k], b = corners[(k + 1) % nc];
    const m = via[k];
    const pa = partner[k], pb = partner[(k + 1) % nc];
    if (m && via[(k + 1) % nc] === m) {
      if (pa === (k + 1) % nc && pb === k) {
        const half = fitHalf(k, m);
        if (half) {
          fitted[k] = half;
          continue;
        }
      } else if (pb >= 0 && (pb + 1) % nc === pa && pb !== k) {
        fitted[k] = fitPiece(smoothInterior(pieceAt(k), opts.fairing), a.tout, mul(b.tin, -1), opts, noise);
        fitted[pb] = mirrorReversed(fitted[k]!, a.p, m);
        continue;
      }
    }
    fitted[k] = fitPiece(smoothInterior(pieceAt(k), opts.fairing), a.tout, mul(b.tin, -1), opts, noise);
  }

  /** A piece from a corner to its own mirror image: fit up to the axis, mirror the rest. */
  function fitHalf(k: number, m: Mirror): Seg[] | null {
    const a = corners[k];
    const piece = pieceAt(k);
    if (piece.length < 4) return null;
    // Where the piece crosses the axis: the sign change of the signed distance
    // closest to the piece's middle.
    const sd = (p: V) => cross(m.u, sub(p, m.c));
    let total = 0;
    for (let i = 1; i < piece.length; i++) total += len(sub(piece[i], piece[i - 1]));
    let run = 0, at = -1, bestOff = Infinity;
    for (let i = 1; i < piece.length; i++) {
      const d0 = sd(piece[i - 1]), d1 = sd(piece[i]);
      const seg = len(sub(piece[i], piece[i - 1]));
      if ((d0 <= 0 && d1 > 0) || (d0 >= 0 && d1 < 0)) {
        const off = Math.abs(run + seg / 2 - total / 2);
        if (off < bestOff) { bestOff = off; at = i; }
      }
      run += seg;
    }
    if (at < 0 || bestOff > total * 0.2) return null;
    const p0 = piece[at - 1], p1 = piece[at];
    const d0 = sd(p0), d1 = sd(p1);
    const apex = add(p0, mul(sub(p1, p0), d0 / (d0 - d1)));
    // A curve symmetric about a line crosses it at right angles.
    const tangent = perpendicularTo(m.u, sub(p1, p0));
    const half = [...piece.slice(0, at), apex];
    if (half.length < 2 || len(sub(apex, a.p)) < 0.5) return null;
    const first = fitPiece(smoothInterior(half, opts.fairing), a.tout, mul(tangent, -1), opts, noise, true);
    const second = mirrorReversed(first, a.p, m);
    // Two collinear lines meeting on the axis are one line.
    const last = first[first.length - 1], next = second[0];
    if (last.t === 'L' && next.t === 'L' && first.length >= 1) {
      const from: V = first.length >= 2 ? endOf(first[first.length - 2]) : a.p;
      const v1 = norm(sub(endOf(last), from)), v2 = norm(sub(endOf(next), endOf(last)));
      if (dot(v1, v2) > Math.cos(0.5 * DEG)) return [...first.slice(0, -1), ...second];
    }
    return [...first, ...second];
  }

  const segs: Seg[] = [{ t: 'M', x: corners[0].p[0], y: corners[0].p[1] }];
  for (const piece of fitted) for (const c of piece!) segs.push(c);
  segs.push({ t: 'Z' });
  return segs;
}

const endOf = (s: Seg): V => [(s as { x: number }).x, (s as { y: number }).y];

function reflectPoint(p: V, c: V, u: V): V {
  const d = sub(p, c), t = dot(d, u);
  return [c[0] + 2 * t * u[0] - d[0], c[1] + 2 * t * u[1] - d[1]];
}

function reflectDir(d: V, u: V): V {
  const t = dot(d, u);
  return [2 * t * u[0] - d[0], 2 * t * u[1] - d[1]];
}

/** Unit vector perpendicular to the axis direction u, oriented like `like`. */
function perpendicularTo(u: V, like: V): V {
  const t: V = [-u[1], u[0]];
  return dot(t, like) >= 0 ? t : [-t[0], -t[1]];
}

/** The mirror image of a run of segments starting at `start`, traversed backwards (so it continues where they end). */
function mirrorReversed(segs: Seg[], start: V, m: Mirror): Seg[] {
  const R = (p: V) => reflectPoint(p, m.c, m.u);
  const ends: V[] = [start, ...segs.map(endOf)];
  const out: Seg[] = [];
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i], to = R(ends[i]);
    if (s.t === 'C') {
      const c1 = R([s.x2, s.y2]), c2 = R([s.x1, s.y1]);
      out.push({ t: 'C', x1: c1[0], y1: c1[1], x2: c2[0], y2: c2[1], x: to[0], y: to[1] });
    } else {
      out.push({ t: 'L', x: to[0], y: to[1] });
    }
  }
  return out;
}

/**
 * Taubin λ|μ fairing of a piece's interior: alternating shrink (λ) and inflate
 * (μ) Laplacian steps remove small-scale ripple, such as coverage quantisation
 * and the flattening facets a rasteriser leaves on curved strokes, without the
 * shrinkage plain smoothing causes on tight curves. Endpoints are corners and
 * stay fixed.
 */
function smoothInterior(piece: V[], iterations = 6): V[] {
  iterations = Math.max(0, Math.round(iterations));
  if (piece.length <= 4) return piece;
  let cur = piece.map((p): V => [p[0], p[1]]);
  const step = (factor: number) => {
    const next: V[] = [cur[0]];
    for (let i = 1; i < cur.length - 1; i++) {
      const mx = (cur[i - 1][0] + cur[i + 1][0]) / 2, my = (cur[i - 1][1] + cur[i + 1][1]) / 2;
      next.push([cur[i][0] + factor * (mx - cur[i][0]), cur[i][1] + factor * (my - cur[i][1])]);
    }
    next.push(cur[cur.length - 1]);
    cur = next;
  };
  for (let k = 0; k < iterations; k++) {
    step(0.5);
    step(-0.53);
  }
  return cur;
}

/**
 * Node reduction: merge neighbouring cubics when one cubic, keeping the outer
 * end tangents, reproduces both within half the tolerance. Schneider's greedy
 * splitting leaves more nodes than needed, and every extra node is a place a
 * curve can visibly change course.
 */
function reduceNodes(cubics: Cubic[], tol: number): Cubic[] {
  const out = [...cubics];
  let merged = true;
  while (merged && out.length > 1) {
    merged = false;
    for (let k = 0; k + 1 < out.length; k++) {
      const a = out[k], b = out[k + 1];
      const samples: V[] = [];
      for (let s = 0; s <= 12; s++) samples.push(bez(a, s / 12));
      for (let s = 1; s <= 12; s++) samples.push(bez(b, s / 12));
      const t1 = norm(sub(a[1], a[0])), t2 = norm(sub(b[2], b[3]));
      let u = chordParams(samples, 0, samples.length - 1);
      let c = generateBezier(samples, 0, samples.length - 1, u, t1, t2);
      for (let it = 0; it < 4; it++) {
        u = reparameterize(samples, 0, c, u);
        c = generateBezier(samples, 0, samples.length - 1, u, t1, t2);
      }
      const [err] = maxError(samples, 0, c, u);
      if (err <= tol * 0.5) {
        out.splice(k, 2, c);
        merged = true;
        break;
      }
    }
  }
  return out;
}

function fitPiece(piece: V[], t1: V, t2: V, opts: FitOptions, noise: number, lockEnds = false): Seg[] {
  const a = piece[0], b = piece[piece.length - 1];
  // Fairing: a long edge whose deviation stays within a hair of its length is a
  // line (a 0.4 px bow over 100 px is a radius of ~3000 px), so residual pixel
  // noise does not turn straight edges into wavy curves. `noise` is the
  // contour's measured σ; the piece was smoothed, which roughly halves it.
  const allowance = Math.max(opts.lineTolerance, Math.min(0.4, len(sub(b, a)) * 0.004));
  let straight = true, sq = 0;
  for (let i = 1; i < piece.length - 1 && straight; i++) {
    const e = distToSegment(piece[i], a, b);
    sq += e * e;
    if (e > Math.max(allowance * 1.5, noise * 3)) straight = false;
  }
  const rms = Math.sqrt(sq / Math.max(1, piece.length - 2));
  if (straight && rms <= Math.max(allowance * 0.6, noise * 0.9)) return [{ t: 'L', x: b[0], y: b[1] }];

  // Mixed pieces (a stem flowing into a bowl): exact lines for the straight
  // runs, curves between them with tangents locked to those lines so every
  // join is smooth (G1), the way a designer would draw it.
  // Straight runs snap to exact 0/45/90° like corner arms, so small-text stems
  // and rules come out perfectly upright.
  let runs = straightRuns(piece, Math.max(opts.lineTolerance * 0.5, noise * 0.9), 6 * Math.max(1, opts.scale ?? 1)).map((r) => ({
    ...r,
    line: { ...r.line, d: snapDirection(r.line.d, opts.snapAngle) },
  }));

  // Facets: rasterisers draw curved strokes as chains of straight pieces a few
  // degrees apart. Runs that meet their neighbour at a gentle angle across a
  // short gap are facets of one smooth curve, not real straight edges, so they
  // are dropped and the whole stretch is refit as a curve with the (looser)
  // fairing tolerance. A run joined to a real bend (a U's stem meeting its
  // bowl) keeps its line.
  const facet = new Array(runs.length).fill(false);
  for (let k = 0; k + 1 < runs.length; k++) {
    const r1 = runs[k], r2 = runs[k + 1];
    const gapLen = len(sub(piece[r2.s], piece[r1.e]));
    const bend = Math.acos(Math.max(-1, Math.min(1, dot(r1.line.d, r2.line.d))));
    if (bend < 25 * DEG && gapLen < 10) facet[k] = facet[k + 1] = true;
  }
  const hadFacets = facet.some(Boolean);
  // A leaf's side hugs a line for a while but is one gentle curve: a run that
  // visibly bends (its parabola rises more than 0.25% of its length) is not a
  // straight edge, and is drawn as part of the curve. True stems, walls and the
  // sides of rounded rectangles do not bend and keep their exact lines.
  let hadBent = false;
  runs = runs.filter((r, k) => {
    if (facet[k]) return false;
    const f = parabolaBend(piece.slice(r.s, r.e + 1), r.line);
    const bent = !!f && f.c > 0.0025 * f.length;
    hadBent ||= bent;
    return !bent;
  });
  // A curve that absorbed a bent run spans more of the outline; at full
  // tolerance it would drift where the run hugged the edge, so it is held to
  // half the tolerance (still fewer nodes than the line-and-curve split).
  const curveOpts = hadFacets
    ? { ...opts, fitTolerance: Math.max(opts.fitTolerance, opts.fairTolerance ?? 0.5) }
    : hadBent
      ? { ...opts, fitTolerance: opts.fitTolerance * 0.5 }
      : opts;
  if (!runs.length) return fitCurve(piece, t1, t2, curveOpts, lockEnds, lockEnds);
  return fitRunsAndCurves(piece, runs, a, b, t1, t2, curveOpts, lockEnds);
}

/** Exact lines for the straight runs, tangent-locked curves between them. */
function fitRunsAndCurves(piece: V[], runs: Array<{ s: number; e: number; line: Line }>, a: V, b: V, t1: V, t2: V, curveOpts: FitOptions, lockEnds: boolean): Seg[] {
  const out: Seg[] = [];
  let from = 0;
  let fromPt: V = a;
  let fromTan: V = norm(t1);
  for (const run of runs) {
    const startPt = run.s === 0 ? a : project(piece[run.s], run.line);
    const endPt = run.e === piece.length - 1 ? b : project(piece[run.e], run.line);
    if (run.s > from) {
      const curve = [fromPt, ...piece.slice(from + 1, run.s), startPt];
      out.push(...(len(sub(startPt, fromPt)) < 0.75 ? [{ t: 'L', x: startPt[0], y: startPt[1] } as Seg] : fitCurve(curve, fromTan, mul(run.line.d, -1), curveOpts, from > 0 || lockEnds, true)));
    }
    out.push({ t: 'L', x: endPt[0], y: endPt[1] });
    from = run.e;
    fromPt = endPt;
    fromTan = run.line.d;
  }
  if (from < piece.length - 1) {
    const curve = [fromPt, ...piece.slice(from + 1, piece.length - 1), b];
    out.push(...(len(sub(b, fromPt)) < 0.75 ? [{ t: 'L', x: b[0], y: b[1] } as Seg] : fitCurve(curve, fromTan, norm(t2), curveOpts, true, lockEnds)));
  }
  return out;
}

/**
 * Arc first, else Béziers. Ends that join a straight run are tangent-locked:
 * an arc is only accepted there if it leaves along the line (within 4°), so
 * line→curve joins stay smooth (G1).
 */
function fitCurve(pts: V[], t1: V, t2: V, opts: FitOptions, lockStart = false, lockEnd = false): Seg[] {
  const arc = fitArc(pts, opts.fitTolerance);
  const aligned = (u: V, v: V) => dot(norm(u), norm(v)) >= Math.cos(4 * DEG);
  if (arc && (!lockStart || aligned(sub(arc[0][1], arc[0][0]), t1)) && (!lockEnd || aligned(sub(arc[arc.length - 1][2], arc[arc.length - 1][3]), t2))) {
    return arc.map(toSeg);
  }
  return fitBeziers(pts, t1, t2, opts).map(toSeg);
}

/** Fewest-node fit when `optimal` (default), else greedy Schneider + node reduction. */
function fitBeziers(pts: V[], t1: V, t2: V, opts: FitOptions): Cubic[] {
  if (opts.optimal !== false) {
    const best = optimalCubics(pts, norm(t1), norm(t2), opts.fitTolerance);
    if (best) return best;
  }
  const out: Cubic[] = [];
  fitCubic(pts, 0, pts.length - 1, norm(t1), norm(t2), opts.fitTolerance, out);
  return reduceNodes(out, opts.fitTolerance);
}

/** Sum of squared distances from d[i..j] to cubic c (chord-length parameters, Newton-refined). */
function spanSse(d: V[], i: number, j: number, c: Cubic): number {
  let u = chordParams(d, i, j);
  u = reparameterize(d, i, c, u);
  let e = 0;
  for (let k = 0; k < u.length; k++) {
    const q = bez(c, u[k]);
    e += (q[0] - d[i + k][0]) ** 2 + (q[1] - d[i + k][1]) ** 2;
  }
  return e;
}

/** One cubic through d[i..j] with fixed end tangents; returns it with its max error. */
function fitSpan(d: V[], i: number, j: number, t1: V, t2: V): [Cubic, number] {
  if (j - i < 2) {
    const dist = len(sub(d[j], d[i])) / 3;
    return [[d[i], add(d[i], mul(t1, dist)), add(d[j], mul(t2, dist)), d[j]], 0];
  }
  let u = chordParams(d, i, j);
  let c = generateBezier(d, i, j, u, t1, t2);
  let [err] = maxError(d, i, c, u);
  for (let k = 0; k < 6 && err > 1e-3; k++) {
    const u2 = reparameterize(d, i, c, u);
    const c2 = generateBezier(d, i, j, u2, t1, t2);
    const [e2] = maxError(d, i, c2, u2);
    if (e2 >= err) break;
    u = u2;
    c = c2;
    err = e2;
  }
  return [c, err];
}

/**
 * Optimal segmentation: the fewest cubics that keep every point within `tol`.
 * A sub-span of a fittable span is (in practice) fittable too, so for each
 * candidate breakpoint a binary search finds the farthest breakpoint one cubic
 * can reach; the minimum number of hops from start to end is then found over
 * those reaches. O(m log m) curve fits instead of O(m²), with the same result.
 * Neighbouring cubics share the tangent estimated at their breakpoint, so joins
 * are smooth. Greedy splitting (Schneider) typically needs noticeably more nodes.
 */
function optimalCubics(pts: V[], t1: V, t2: V, tol: number): Cubic[] | null {
  const n = pts.length;
  if (n < 3) return null;
  const step = Math.max(1, Math.ceil((n - 1) / 160));
  const cand: number[] = [];
  for (let i = 0; i < n - 1; i += step) cand.push(i);
  cand.push(n - 1);
  const m = cand.length;
  // Forward tangent at each breakpoint (ends use the given constraints).
  const fwd: V[] = cand.map((i, k) => {
    if (k === 0) return t1;
    if (k === m - 1) return mul(t2, -1);
    const reach = Math.max(2, step);
    return norm(sub(pts[Math.min(n - 1, i + reach)], pts[Math.max(0, i - reach)]));
  });
  const fits = (a: number, b: number) => fitSpan(pts, cand[a], cand[b], fwd[a], mul(fwd[b], -1))[1] <= tol;

  // Farthest reachable breakpoint from each start.
  const reach = new Int32Array(m).fill(-1);
  for (let a = 0; a < m - 1; a++) {
    if (!fits(a, a + 1)) continue;
    let lo = a + 1, hi = m - 1;
    if (fits(a, hi)) lo = hi;
    else {
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (fits(a, mid)) lo = mid;
        else hi = mid;
      }
    }
    reach[a] = lo;
  }

  // Fewest hops; ties keep the earliest predecessor (the longest final span).
  const cost = new Int32Array(m).fill(0x7fffffff);
  const from = new Int32Array(m).fill(-1);
  cost[0] = 0;
  for (let a = 0; a < m - 1; a++) {
    if (cost[a] === 0x7fffffff || reach[a] < 0) continue;
    for (let b = a + 1; b <= reach[a]; b++) {
      if (cost[a] + 1 < cost[b]) {
        cost[b] = cost[a] + 1;
        from[b] = a;
      }
    }
  }
  if (from[m - 1] < 0) return null;
  const path: number[] = [];
  for (let k = m - 1; k > 0; k = from[k]) path.push(k);
  path.push(0);
  path.reverse();

  // Same segment count, best fit: nudge each interior breakpoint to where the
  // two curves meeting there have the least total squared error.
  const sse = (a: number, b: number) => {
    const [c, max] = fitSpan(pts, cand[a], cand[b], fwd[a], mul(fwd[b], -1));
    return max <= tol ? spanSse(pts, cand[a], cand[b], c) : Infinity;
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 1; k + 1 < path.length; k++) {
      const a = path[k - 1], c = path[k + 1];
      let best = path[k], bestE = sse(a, best) + sse(best, c);
      for (let b = Math.max(a + 1, path[k] - 6); b <= Math.min(c - 1, path[k] + 6); b++) {
        if (b === path[k]) continue;
        const e = sse(a, b) + sse(b, c);
        if (e < bestE) { bestE = e; best = b; }
      }
      path[k] = best;
    }
  }
  const out: Cubic[] = [];
  for (let k = 0; k + 1 < path.length; k++) {
    const a = path[k], b = path[k + 1];
    out.push(fitSpan(pts, cand[a], cand[b], fwd[a], mul(fwd[b], -1))[0]);
  }
  return out;
}

/** Algebraic (Kåsa) least-squares circle: x² + y² + Dx + Ey + F = 0. */
function kasaCircle(pts: V[]): { c: V; r: number } | null {
  if (pts.length < 4) return null;
  // Centre the data for numerical stability.
  let mx = 0, my = 0;
  for (const p of pts) { mx += p[0]; my += p[1]; }
  mx /= pts.length;
  my /= pts.length;
  let sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0, sz = 0;
  for (const p of pts) {
    const x = p[0] - mx, y = p[1] - my, z = x * x + y * y;
    sxx += x * x; sxy += x * y; syy += y * y; sxz += x * z; syz += y * z; sz += z;
  }
  const det = sxx * syy - sxy * sxy;
  if (Math.abs(det) < 1e-12) return null;
  // With centred data the linear system decouples: solve for D, E; F = -mean(z).
  const D = -(sxz * syy - syz * sxy) / det;
  const E = -(syz * sxx - sxz * sxy) / det;
  const F = -sz / pts.length;
  const cx = -D / 2, cy = -E / 2;
  const r2 = cx * cx + cy * cy - F;
  if (r2 <= 0) return null;
  return { c: [cx + mx, cy + my], r: Math.sqrt(r2) };
}

function project(p: V, l: Line): V {
  return add(l.c, mul(l.d, dot(sub(p, l.c), l.d)));
}

/**
 * Maximal straight runs (≥ 5 px) inside a piece, greedy left to right. Line
 * fits use running sums, so extending a run is O(1); the RMS distance to the
 * total-least-squares line is the smaller eigenvalue of the covariance.
 */
function straightRuns(pts: V[], rmsTol: number, MIN_LEN = 6): Array<{ s: number; e: number; line: Line }> {
  const runs: Array<{ s: number; e: number; line: Line }> = [];
  const n = pts.length;
  let s = 0;
  while (s < n - 2) {
    let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, k = 0;
    const addPt = (p: V) => { sx += p[0]; sy += p[1]; sxx += p[0] * p[0]; sxy += p[0] * p[1]; syy += p[1] * p[1]; k++; };
    const rmsNow = () => {
      const mx = sx / k, my = sy / k;
      const cxx = sxx / k - mx * mx, cxy = sxy / k - mx * my, cyy = syy / k - my * my;
      const tr = cxx + cyy, det = cxx * cyy - cxy * cxy;
      return Math.sqrt(Math.max(0, tr / 2 - Math.sqrt(Math.max(0, (tr * tr) / 4 - det))));
    };
    addPt(pts[s]);
    addPt(pts[s + 1]);
    let e = s + 1;
    while (e + 1 < n) {
      addPt(pts[e + 1]);
      if (rmsNow() > rmsTol) {
        // undo the last point
        const p = pts[e + 1];
        sx -= p[0]; sy -= p[1]; sxx -= p[0] * p[0]; sxy -= p[0] * p[1]; syy -= p[1] * p[1]; k--;
        break;
      }
      e++;
    }
    if (len(sub(pts[e], pts[s])) >= MIN_LEN && e - s >= 3) {
      let run = pts.slice(s, e + 1);
      let line = fitLineOnce(run)!;
      if (line.dev <= rmsTol * 3.5 && !bowed(run, line, rmsTol)) {
        // A curve hugs its tangent line at first, so a greedy run swallows the
        // start of the next bowl (a U's counter then comes out flattened). Trim
        // ends that have begun to leave the line, so the curve starts at the
        // true tangent point.
        const off = (p: V) => Math.abs(cross(line.d, sub(p, line.c)));
        const leave = Math.max(0.05, rmsTol * 0.6);
        let s2 = s, e2 = e;
        while (e2 - s2 > 3 && off(pts[e2]) > leave) e2--;
        while (e2 - s2 > 3 && off(pts[s2]) > leave) s2++;
        if (s2 !== s || e2 !== e) {
          run = pts.slice(s2, e2 + 1);
          line = fitLineOnce(run)!;
        }
        // The trimmed run must still be straight in its own right.
        if (len(sub(pts[e2], pts[s2])) >= MIN_LEN && (run.length === e - s + 1 || !bowed(run, line, rmsTol))) {
          runs.push({ s: s2, e: e2, line });
          s = e2;
          continue;
        }
      }
    }
    s++;
  }
  return runs;
}

/**
 * A short stretch of a gentle curve fits a line within noise, but its residuals
 * bow: the middle sits on one side, the ends on the other. Noise has no such
 * pattern. Two tests: the mean signed offset of the middle half against the
 * outer half, and the quadratic term of a parabola fitted to the offsets, which
 * also catches a bend that tightens towards one end (a leaf's side) and is
 * judged against the noise left after the parabola, so straight noisy edges
 * stay lines.
 */
function bowed(run: V[], line: Line, noise: number): boolean {
  const n = run.length;
  if (n < 6) return false;
  const nrm: V = [-line.d[1], line.d[0]];
  let mid = 0, midN = 0, outer = 0, outerN = 0;
  for (let i = 0; i < n; i++) {
    const d = dot(sub(run[i], line.c), nrm);
    const t = i / (n - 1);
    if (t > 0.25 && t < 0.75) { mid += d; midN++; }
    else { outer += d; outerN++; }
  }
  const bow = Math.abs(mid / Math.max(1, midN) - outer / Math.max(1, outerN));
  if (bow > Math.max(0.035, (2.5 * noise) / Math.sqrt(n))) return true;
  const fit = parabolaBend(run, line);
  if (!fit) return false;
  // Standard error of c for points spread evenly over [−1, 1] is ≈ 3.35σ/√n.
  return fit.c > 3 * ((3.35 * fit.sigma) / Math.sqrt(n)) && fit.c > Math.max(0.035, 0.0025 * fit.length);
}

/**
 * Parabola d ≈ a + b·u + c·u² fitted to a run's offsets from its line, with u
 * scaled to [−1, 1] along it: c is the rise from middle to ends (px), sigma the
 * residual left over, length the run's extent along the line.
 */
function parabolaBend(run: V[], line: Line): { c: number; sigma: number; length: number } | null {
  const n = run.length;
  if (n < 4) return null;
  const nrm: V = [-line.d[1], line.d[0]];
  const us = run.map((p) => dot(sub(p, line.c), line.d)), ds = run.map((p) => dot(sub(p, line.c), nrm));
  const lo = Math.min(...us), hi = Math.max(...us);
  if (!(hi - lo > 1e-6)) return null;
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], rhs = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const u = (2 * (us[i] - lo)) / (hi - lo) - 1, f = [1, u, u * u];
    for (let a = 0; a < 3; a++) {
      rhs[a] += f[a] * ds[i];
      for (let b = 0; b < 3; b++) M[a][b] += f[a] * f[b];
    }
  }
  const coef = solve3(M, rhs);
  if (!coef) return null;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const u = (2 * (us[i] - lo)) / (hi - lo) - 1;
    sq += (ds[i] - coef[0] - coef[1] * u - coef[2] * u * u) ** 2;
  }
  return { c: Math.abs(coef[2]), sigma: Math.max(0.02, Math.sqrt(sq / Math.max(1, n - 3))), length: hi - lo };
}

/** Solves a 3×3 linear system (Cramer's rule); null when singular. */
function solve3(m: number[][], r: number[]): [number, number, number] | null {
  const det = (a: number[][]) =>
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const D = det(m);
  if (Math.abs(D) < 1e-12) return null;
  const col = (j: number) => det(m.map((row, i) => row.map((v, k) => (k === j ? r[i] : v))));
  return [col(0) / D, col(1) / D, col(2) / D];
}

/**
 * Corner-free loop that is not an ellipse (a capsule, a hairline with round or
 * narrow ends, a blob). It goes through the same machinery as pieces between
 * corners, straight runs as exact lines and tangent-locked curves between, so
 * a hairline's long sides come out straight rather than gently bulging. The
 * seam sits at the point of highest curvature (inside an end cap), so no
 * straight run is cut in two, and the seam tangent is shared, so it is invisible.
 */
function smoothLoop(pts: V[], tol: number, opts: FitOptions, noise: number): Seg[] {
  const n = pts.length;
  let seam = 0, best = -1;
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 2 + n) % n], b = pts[i], c = pts[(i + 2) % n];
    const k = Math.abs(cross(norm(sub(b, a)), norm(sub(c, b))));
    if (k > best) { best = k; seam = i; }
  }
  const loop: V[] = [];
  for (let i = 0; i <= n; i++) loop.push(pts[(seam + i) % n]);
  const t = norm(sub(pts[(seam + 2) % n], pts[(seam - 2 + n) % n]));
  const segs = fitPiece(smoothInterior(loop, opts.fairing), t, mul(t, -1), { ...opts, fitTolerance: tol }, noise, true);
  return [{ t: 'M', x: loop[0][0], y: loop[0][1] }, ...segs, { t: 'Z' }];
}

function toSeg(c: Cubic): Seg {
  return { t: 'C', x1: c[1][0], y1: c[1][1], x2: c[2][0], y2: c[2][1], x: c[3][0], y: c[3][1] };
}

function fromCubics(cubics: Cubic[]): Seg[] {
  return [{ t: 'M', x: cubics[0][0][0], y: cubics[0][0][1] }, ...cubics.map(toSeg), { t: 'Z' }];
}

function polygon(pts: V[]): Seg[] {
  if (pts.length < 3 || Math.abs(signedArea(pts)) < 1e-6) return [];
  return [{ t: 'M', x: pts[0][0], y: pts[0][1] }, ...pts.slice(1).map((p): Seg => ({ t: 'L', x: p[0], y: p[1] })), { t: 'Z' }];
}
