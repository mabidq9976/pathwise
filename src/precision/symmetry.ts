// Mirror-symmetry recovery. Designed shapes (domes, arches, windows, finials,
// star points, whole stars and crosses) are mirror-symmetric, but the pixels
// they reach us through are not: anti-aliasing, JPEG noise and upscalers push
// one side a little in and the other a little out. A human tracer draws them
// symmetric anyway. This finds stretches of a contour that mirror each other
// about some axis within a tolerance and makes them exactly symmetric, before
// any corner detection or curve fitting, and reports each mirror so the fitter
// can fit one half and mirror it (curve fitting is otherwise free to deviate
// differently on the two sides).

type V = [number, number];

/** A mirror symmetry found on the contour. */
export interface Mirror {
  /** Axis: a point on it and its unit direction. */
  c: V;
  u: V;
  /** Fractional index of the point mirroring pts[i], or null when i lies outside this symmetric stretch. */
  partner(i: number): number | null;
}

export interface Symmetry {
  /** The contour with symmetric stretches made exact (the input array when none were found). */
  pts: V[];
  mirrors: Mirror[];
}

export interface SymmetryOptions {
  /** Max RMS asymmetry (px) still treated as noise. */
  tolerance: number;
  /** Shortest symmetric stretch (arc length, px) worth enforcing. */
  minSpan: number;
  /** Optional hook receiving each applied stretch (diagnostics only). */
  debug?: (info: { apex: V; axis?: V; length?: number; pairs?: number; rejected?: string }) => void;
}

/** Left sample index paired with a fractional position on the right (both unwrapped). */
interface Pair {
  l: number;
  r: number;
}

interface Span {
  k0: number;
  pairs: Pair[];
  /** Axis: point on it and unit direction. */
  c: V;
  u: V;
  /** Arc length covered. */
  length: number;
  /** RMS mirror residual (px). */
  rms: number;
}

const DEG = Math.PI / 180;

export function symmetrize(pts: V[], opts: SymmetryOptions): Symmetry {
  const none: Symmetry = { pts, mirrors: [] };
  const n = pts.length;
  if (n < 12 || opts.tolerance <= 0) return none;

  // Uniform resampling (at the contour's own mean spacing) so both sides of an
  // axis advance at the same rate.
  const S = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) S[i] = S[i - 1] + Math.hypot(pts[i % n][0] - pts[i - 1][0], pts[i % n][1] - pts[i - 1][1]);
  const L = S[n];
  if (L < opts.minSpan) return none;
  const step = Math.max(0.35, Math.min(1, L / n));
  const m = Math.floor(L / step);
  if (m < 12) return none;
  const Q: V[] = new Array(m);
  for (let k = 0, j = 0; k < m; k++) {
    const s = k * step;
    while (j < n - 1 && S[j + 1] <= s) j++;
    const a = pts[j], b = pts[(j + 1) % n], seg = S[j + 1] - S[j];
    const t = seg > 0 ? (s - S[j]) / seg : 0;
    Q[k] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  const at = (k: number) => Q[((k % m) + m) % m];
  const tangentAngle = (k: number) => {
    const a = at(k - 1), b = at(k + 1);
    return Math.atan2(b[1] - a[1], b[0] - a[0]);
  };
  /** How far the tangent swings over a stretch (max − min of the running turn). */
  const swingBetween = (from: number, to: number) => {
    let run = 0, lo = 0, hi = 0, prev = tangentAngle(from);
    for (let k = from + 1; k <= to; k++) {
      const a = tangentAngle(k);
      let d = a - prev;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      run += d;
      lo = Math.min(lo, run);
      hi = Math.max(hi, run);
      prev = a;
    }
    return hi - lo;
  };
  const turnBetween = (from: number, to: number) => {
    let total = 0, prev = tangentAngle(from);
    for (let k = from + 1; k <= to; k++) {
      const a = tangentAngle(k);
      let d = a - prev;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      total += d;
      prev = a;
    }
    return total;
  };

  // Seeds: tops/bottoms/sides of bumps (where a vertical or horizontal mirror
  // axis would cross the contour) and sharp tips (axis along the bisector).
  const W = Math.max(3, Math.round(3 / step));
  const bend = Math.max(4, Math.round(8 / step));
  const seeds: Array<{ k: number; guess: V }> = [];
  for (let k = 0; k < m; k++) {
    const p = Q[k];
    for (const axis of [0, 1] as const) {
      // axis 0: extremum in y → vertical mirror axis; axis 1: extremum in x → horizontal.
      const c = axis === 0 ? 1 : 0;
      let isMin = true, isMax = true;
      for (let d = 1; d <= W && (isMin || isMax); d++) {
        const a = at(k - d)[c], b = at(k + d)[c];
        if (a < p[c] || b <= p[c]) isMin = false;
        if (a > p[c] || b >= p[c]) isMax = false;
      }
      if ((isMin || isMax) && Math.abs(turnBetween(k - bend, k + bend)) >= 15 * DEG) {
        seeds.push({ k, guess: axis === 0 ? [0, 1] : [1, 0] });
      }
    }
    // Sharp tip: strong local turn; axis guess along the bisector.
    const a = at(k - W), b = at(k + W);
    const v1: V = [p[0] - a[0], p[1] - a[1]], v2: V = [b[0] - p[0], b[1] - p[1]];
    const turn = Math.atan2(Math.abs(v1[0] * v2[1] - v1[1] * v2[0]), v1[0] * v2[0] + v1[1] * v2[1]);
    if (turn >= 45 * DEG) {
      let isPeak = true;
      for (let d = 1; d <= W && isPeak; d++) {
        for (const j of [k - d, k + d]) {
          const q = at(j), qa = at(j - W), qb = at(j + W);
          const w1: V = [q[0] - qa[0], q[1] - qa[1]], w2: V = [qb[0] - q[0], qb[1] - q[1]];
          const t2 = Math.atan2(Math.abs(w1[0] * w2[1] - w1[1] * w2[0]), w1[0] * w2[0] + w1[1] * w2[1]);
          if (t2 > turn || (t2 === turn && j < k)) isPeak = false;
        }
      }
      if (isPeak) {
        const chord: V = [b[0] - a[0], b[1] - a[1]];
        const cl = Math.hypot(chord[0], chord[1]) || 1;
        // Mirror axis is perpendicular to the chord across the tip.
        seeds.push({ k, guess: [-chord[1] / cl, chord[0] / cl] });
      }
    }
  }

  const tol = opts.tolerance;
  // Domes, arches and whole windows or stars; not a whole page-sized outline.
  const maxK = Math.min(Math.floor((m - 1) / 2), Math.round(600 / step));
  const reflect = (p: V, c: V, u: V): V => {
    const dx = p[0] - c[0], dy = p[1] - c[1];
    const t = dx * u[0] + dy * u[1];
    return [c[0] + 2 * t * u[0] - dx, c[1] + 2 * t * u[1] - dy];
  };
  const snapAxis = (u: V): V => {
    for (const ref of [[0, 1], [1, 0]] as V[]) {
      const cos = Math.abs(u[0] * ref[0] + u[1] * ref[1]);
      if (cos > Math.cos(3 * DEG)) return ref;
    }
    return u;
  };

  const idx = (j: number) => ((j % m) + m) % m;
  /** Point at fractional sample position f along G. */
  const pointOn = (G: V[], f: number): V => {
    const k = Math.floor(f), t = f - k, a = G[idx(k)], b = G[idx(k + 1)];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };
  /**
   * Least-squares mirror line mapping the left points onto their partners (the
   * apex pairs with itself): a reflection is x → A·x + b with A = [[cos 2θ,
   * sin 2θ], [sin 2θ, −cos 2θ]], solved in closed form like Procrustes.
   */
  const axisFrom = (G: V[], k0: number, pairs: Pair[], guess: V): { c: V; u: V } | null => {
    const ls: V[] = [G[k0]], rs: V[] = [G[k0]];
    for (const { l, r } of pairs) {
      ls.push(G[idx(l)]);
      rs.push(pointOn(G, r));
    }
    const n = ls.length;
    let lx = 0, ly = 0, rx = 0, ry = 0;
    for (let i = 0; i < n; i++) {
      lx += ls[i][0]; ly += ls[i][1]; rx += rs[i][0]; ry += rs[i][1];
    }
    lx /= n; ly /= n; rx /= n; ry /= n;
    let sc = 0, ss = 0;
    for (let i = 0; i < n; i++) {
      const Lx = ls[i][0] - lx, Ly = ls[i][1] - ly, Rx = rs[i][0] - rx, Ry = rs[i][1] - ry;
      sc += Rx * Lx - Ry * Ly;
      ss += Rx * Ly + Ry * Lx;
    }
    if (Math.hypot(sc, ss) < 1e-9) return null;
    const theta = Math.atan2(ss, sc) / 2;
    let u = snapAxis([Math.cos(theta), Math.sin(theta)]);
    if (u[0] * guess[0] + u[1] * guess[1] < 0) u = [-u[0], -u[1]];
    return { c: [(lx + rx) / 2, (ly + ry) / 2], u };
  };
  /** Closest point to `target` on G between fractional positions lo and hi. */
  const closestOn = (G: V[], target: V, lo: number, hi: number): [number, number] => {
    let best = Infinity, bestF = (lo + hi) / 2;
    for (let j = Math.floor(lo); j <= Math.floor(hi); j++) {
      const a = G[idx(j)], b = G[idx(j + 1)];
      const ab: V = [b[0] - a[0], b[1] - a[1]];
      const ll = ab[0] * ab[0] + ab[1] * ab[1];
      const t = ll > 1e-12 ? ((target[0] - a[0]) * ab[0] + (target[1] - a[1]) * ab[1]) / ll : 0;
      const f = Math.max(lo, Math.min(hi, j + Math.max(0, Math.min(1, t))));
      const q = pointOn(G, f);
      const e = Math.hypot(q[0] - target[0], q[1] - target[1]);
      if (e < best) { best = e; bestF = f; }
    }
    return [bestF, best];
  };

  /**
   * Walks outwards from apex k0 on both sides. Each left sample is paired with
   * the closest point (between samples) on the right side to its mirror image,
   * so corners pair with corners exactly.
   */
  const grow = (G: V[], start: number, guess: V): Span | null => {
    const k0 = idx(start);
    let u = guess, c: V = G[k0];
    const pairs: Pair[] = [];
    const errs: number[] = [];
    let prevR = k0, good = 0;
    for (let k = 1; k <= maxK; k++) {
      const jl = k0 - k;
      const l = G[idx(jl)];
      const mirrored = reflect(l, c, u);
      // Both sides advance in step (0.5–1.5 samples per sample on the left),
      // so near an acute tip the partner cannot jump to the opposite arm.
      const [bestF, best] = closestOn(G, mirrored, prevR + 0.5, prevR + 1.5);
      // The two sides met on the far side of the shape.
      if (bestF - jl >= m - 1) break;
      prevR = bestF;
      pairs.push({ l: jl, r: bestF });
      errs.push(best);
      if (k >= 4) {
        const axis = axisFrom(G, k0, pairs, guess);
        if (axis) ({ c, u } = axis);
      }
      // Stop once asymmetry exceeds noise (windowed RMS or a single gross miss).
      const win = errs.slice(-6);
      const rms = Math.sqrt(win.reduce((a, e) => a + e * e, 0) / win.length);
      if (best > 2.5 * tol || rms > tol) break;
      if (best <= tol) good = pairs.length;
    }
    const reject = (why: string) => {
      if (G === Q) opts.debug?.({ apex: Q[k0], rejected: why, pairs: pairs.length, length: (pairs.length ? pairs[pairs.length - 1].r - pairs[pairs.length - 1].l : 0) * step });
      return null;
    };
    if (good < 3) return reject('short');
    pairs.length = good;
    const { l: jl, r: jr } = pairs[good - 1];
    const length = (jr - jl) * step;
    if (length < opts.minSpan) return reject('minSpan');
    // A symmetric feature turns: straight edges and gentle waves are symmetric
    // about countless axes and carry no information.
    if (Math.abs(turnBetween(jl, Math.floor(jr))) < 100 * DEG) return reject('turn');
    // Nor does a lone corner: any two straight arms mirror each other about
    // their bisector. Both sides must turn away from the apex too (ignoring the
    // ends, where one side may already be rounding a corner within tolerance).
    const E = 3;
    if (!(jl + E < k0 - W && Math.floor(jr) - E > k0 + W)) return reject('narrow');
    // Swing, not net turn: a dome flank flowing into a finial turns one way and
    // then the other.
    if (swingBetween(jl + E, k0 - W) < 22 * DEG || swingBetween(k0 + W, Math.floor(jr) - E) < 22 * DEG) return reject('lone corner');
    // Refine: re-pair every point against the fitted axis, refit (ICP), so the
    // axis is not biased by partners chosen with an earlier estimate.
    let axis = axisFrom(G, k0, pairs, guess);
    for (let iter = 0; iter < 3 && axis; iter++) {
      let prev = k0;
      for (const pair of pairs) {
        const target = reflect(G[idx(pair.l)], axis.c, axis.u);
        pair.r = closestOn(G, target, Math.max(prev + 0.5, pair.r - 1), Math.max(prev + 0.5, pair.r - 1) + 2)[0];
        prev = pair.r;
      }
      axis = axisFrom(G, k0, pairs, guess);
    }
    if (!axis) return null;
    if (pairs[pairs.length - 1].r - pairs[pairs.length - 1].l >= m - 1) pairs.pop();
    // Reject when the final axis leaves the stretch asymmetric.
    let sq = 0;
    for (const { l, r } of pairs) {
      const mr = reflect(G[idx(l)], axis.c, axis.u), pb = pointOn(G, r);
      sq += (mr[0] - pb[0]) ** 2 + (mr[1] - pb[1]) ** 2;
    }
    const rms = Math.sqrt(sq / pairs.length);
    if (rms > tol) return reject('residual');
    // Designed symmetry is upright (domes, arches, windows, crosses) or covers a
    // whole closed shape at any angle (a star, a dot). A local mirror at some
    // other angle, such as where two veins of a drawn leaf meet, is coincidence.
    const upright = Math.abs(axis.u[0]) === 1 || Math.abs(axis.u[1]) === 1;
    const whole = pairs[pairs.length - 1].r - pairs[pairs.length - 1].l >= m - 3;
    if (!upright && !whole) return reject('tilted');
    return { k0, pairs, c: axis.c, u: axis.u, length, rms };
  };

  const spans: Span[] = [];
  for (const seed of seeds) {
    // The apex itself may be off by a sample or two: keep the longest growth.
    let bestSpan: Span | null = null;
    for (let d = -2; d <= 2; d++) {
      const s = grow(Q, seed.k + d, seed.guess);
      if (s && (!bestSpan || s.length > bestSpan.length)) bestSpan = s;
    }
    if (bestSpan) spans.push(bestSpan);
  }
  if (!spans.length) return none;
  spans.sort((a, b) => b.length - a.length);

  // Apply, longest first, each re-measured on the geometry so far. A stretch
  // already made symmetric about a similar axis is not redone; a different axis
  // (a star's or a cross's other mirrors) is.
  const disp = Q.map((): V => [0, 0]);
  const cur = Q.map((p): V => [p[0], p[1]]);
  const owner: Array<V[] | undefined> = new Array(m);
  let applied = 0;
  const applied_: Span[] = [];
  for (const candidate of spans) {
    const sameAxis = (list: V[] | undefined) => !!list && list.some((u) => Math.abs(u[0] * candidate.u[0] + u[1] * candidate.u[1]) > Math.cos(30 * DEG));
    if (candidate.pairs.some(({ l, r }) => sameAxis(owner[idx(l)]) || sameAxis(owner[idx(Math.round(r))]))) continue;
    const span = grow(cur, candidate.k0, candidate.u);
    if (!span) continue;
    // A second, crossing mirror must hold much more tightly: a small arched
    // window is nearly symmetric top-to-bottom once blurred, but it is not a
    // capsule. Stars and crosses really are, and pass easily.
    const crossing = span.pairs.some(({ l }) => owner[idx(l)]?.length);
    if (crossing && span.rms > tol * 0.5) continue;
    const { c, u, pairs, k0 } = span;
    const K = pairs.length;
    const ramp = Math.max(2, Math.min(8, Math.round(K / 3)));
    const left: Array<[number, V]> = [];
    // Right-side displacements at fractional positions, starting at the apex
    // (which moves onto the axis).
    const p0 = cur[k0], t0 = (p0[0] - c[0]) * u[0] + (p0[1] - c[1]) * u[1];
    const right: Array<[number, V]> = [[k0, [c[0] + t0 * u[0] - p0[0], c[1] + t0 * u[1] - p0[1]]]];
    for (let k = 0; k < K; k++) {
      const { l, r } = pairs[k];
      const w = Math.min(1, (K - k) / ramp);
      const lp = cur[idx(l)], rp = pointOn(cur, r);
      const ml = reflect(lp, c, u);
      const h: V = [(rp[0] + ml[0]) / 2, (rp[1] + ml[1]) / 2];
      const hl = reflect(h, c, u);
      left.push([l, [(hl[0] - lp[0]) * w, (hl[1] - lp[1]) * w]]);
      right.push([r, [(h[0] - rp[0]) * w, (h[1] - rp[1]) * w]]);
    }
    const touched: number[] = [];
    const moves: Array<[number, V]> = [...left];
    for (let k = 1; k < right.length; k++) {
      const [fa, da] = right[k - 1], [fb, db] = right[k];
      for (let j = Math.floor(fa) + 1; j <= fb; j++) {
        const t = fb > fa ? (j - fa) / (fb - fa) : 1;
        moves.push([j, [da[0] + (db[0] - da[0]) * t, da[1] + (db[1] - da[1]) * t]]);
      }
    }
    moves.push([k0, right[0][1]]);
    for (const [j, d] of moves) {
      const q = idx(j);
      cur[q] = [cur[q][0] + d[0], cur[q][1] + d[1]];
      touched.push(q);
    }
    for (const j of touched) (owner[j] ??= []).push(u);
    opts.debug?.({ apex: Q[k0], axis: u, length: span.length, pairs: K });
    applied_.push(span);
    applied++;
  }
  if (!applied) return none;
  for (let k = 0; k < m; k++) disp[k] = [cur[k][0] - Q[k][0], cur[k][1] - Q[k][1]];

  // Move the original points by the displacement at their arc position, so their
  // density and exact corner vertices are kept.
  const out = pts.map((p, i): V => {
    const f = S[i] / step;
    const k = Math.floor(f), t = f - k;
    const a = disp[((k % m) + m) % m], b = disp[(((k + 1) % m) + m) % m];
    return [p[0] + a[0] + (b[0] - a[0]) * t, p[1] + a[1] + (b[1] - a[1]) * t];
  });

  // Partner lookup in original-index terms: arc distance from the apex on one
  // side maps to arc distance on the other through the stretch's pairs.
  const mod = (x: number) => ((x % L) + L) % L;
  const indexAt = (s: number) => {
    s = mod(s);
    let lo = 0, hi = n;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (S[mid] <= s) lo = mid;
      else hi = mid;
    }
    const seg = S[lo + 1] - S[lo];
    return lo + (seg > 0 ? (s - S[lo]) / seg : 0);
  };
  const interp = (xs: number[], ys: number[], x: number) => {
    let lo = 0, hi = xs.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid;
    }
    const t = xs[hi] > xs[lo] ? (x - xs[lo]) / (xs[hi] - xs[lo]) : 0;
    return ys[lo] + (ys[hi] - ys[lo]) * Math.max(0, Math.min(1, t));
  };
  const mirrors = applied_.map((span): Mirror => {
    const s0 = span.k0 * step;
    // Distances from the apex along each side, apex first (both increasing).
    const right = [0, ...span.pairs.map(({ r }) => r * step - s0)];
    const left = [0, ...span.pairs.map(({ l }) => s0 - l * step)];
    const rEnd = right[right.length - 1], lEnd = left[left.length - 1];
    return {
      c: span.c,
      u: span.u,
      partner(i: number) {
        const d = mod(S[i] - s0);
        if (d <= rEnd) return indexAt(s0 - interp(right, left, d));
        const e = mod(s0 - S[i]);
        if (e <= lEnd) return indexAt(s0 + interp(left, right, e));
        return null;
      },
    };
  });
  return { pts: out, mirrors };
}
