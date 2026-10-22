// Marching squares over a coverage field: closed iso-contours at 50% coverage,
// located to a fraction of a pixel by interpolating between pixel centres.

export type Pt = [number, number];

export interface Contour {
  points: Pt[];
  /** Signed area: positive for outer boundaries, negative for holes. */
  area: number;
}

/**
 * `field` is a padded grid of (w + 2) × (h + 2) samples: sample (gx, gy) is the
 * coverage at pixel (gx - 1, gy - 1), and the one-sample border is 0, so every
 * contour closes. Returned points are in image coordinates (pixel edges at
 * integers). Contours keep the region on their right (y down), which makes
 * outer boundaries positive and holes negative.
 */
export class ContourTracer {
  private W: number;
  private H: number;
  private next: Int32Array;
  private touched: number[] = [];

  constructor(W: number, H: number) {
    this.W = W;
    this.H = H;
    this.next = new Int32Array(2 * W * H).fill(-1);
  }

  trace(field: Float32Array, iso = 0.5): Contour[] {
    const { W, H, next } = this;
    const hId = (x: number, y: number) => y * W + x;
    const vId = (x: number, y: number) => W * H + y * W + x;

    const point = (id: number): Pt => {
      if (id < W * H) {
        const y = Math.floor(id / W), x = id - y * W;
        const v0 = field[id], v1 = field[id + 1];
        const t = (iso - v0) / (v1 - v0);
        return [x + t - 0.5, y - 0.5];
      }
      const k = id - W * H;
      const y = Math.floor(k / W), x = k - y * W;
      const v0 = field[k], v1 = field[k + W];
      const t = (iso - v0) / (v1 - v0);
      return [x - 0.5, y + t - 0.5];
    };

    const link = (from: number, to: number) => {
      next[from] = to;
      this.touched.push(from);
    };

    // Fixed orientation table (region on the right, y down), so neighbouring
    // cells always agree on direction and every edge starts exactly one segment.
    for (let y = 0; y < H - 1; y++) {
      for (let x = 0; x < W - 1; x++) {
        const tl = field[y * W + x], tr = field[y * W + x + 1];
        const bl = field[(y + 1) * W + x], br = field[(y + 1) * W + x + 1];
        const c = (tl >= iso ? 8 : 0) | (tr >= iso ? 4 : 0) | (br >= iso ? 2 : 0) | (bl >= iso ? 1 : 0);
        if (c === 0 || c === 15) continue;
        const T = hId(x, y), B = hId(x, y + 1), L = vId(x, y), R = vId(x + 1, y);
        const centreIn = (tl + tr + br + bl) / 4 >= iso;
        switch (c) {
          case 1: link(L, B); break;
          case 14: link(B, L); break;
          case 2: link(B, R); break;
          case 13: link(R, B); break;
          case 4: link(R, T); break;
          case 11: link(T, R); break;
          case 8: link(T, L); break;
          case 7: link(L, T); break;
          case 3: link(L, R); break;
          case 12: link(R, L); break;
          case 6: link(B, T); break;
          case 9: link(T, B); break;
          case 5: // TR and BL inside
            if (centreIn) { link(L, T); link(R, B); }
            else { link(R, T); link(L, B); }
            break;
          case 10: // TL and BR inside
            if (centreIn) { link(T, R); link(B, L); }
            else { link(T, L); link(B, R); }
            break;
        }
      }
    }

    const contours: Contour[] = [];
    for (const start of this.touched) {
      if (next[start] < 0) continue;
      const points: Pt[] = [];
      let e = start;
      while (e >= 0 && next[e] >= 0) {
        points.push(point(e));
        const n = next[e];
        next[e] = -1;
        e = n;
      }
      if (points.length >= 3) contours.push({ points, area: signedArea(points) });
    }
    this.touched.length = 0;
    return contours;
  }
}

/**
 * Sub-pixel edge refinement by the partial-area effect. With box-filtered
 * anti-aliasing, the coverage summed down one pixel column across an edge equals
 * the distance from the window's far side to the edge, so the edge height at that
 * column centre is exact (and near-exact on curves). Interpolating between pixel
 * centres, as marching squares does, is biased by up to ~0.2 px.
 *
 * Mostly-horizontal edges are refined on the crossings that sit on column centres,
 * mostly-vertical edges on the crossings on row centres; crossings of the other
 * kind are redundant there and dropped. Windows that do not span exactly one
 * clean transition (thin strokes, nearby edges) keep the interpolated point.
 */
export function refineEdges(points: Pt[], field: Float32Array, W: number, H: number, geometry?: Float32Array): Pt[] {
  // Edge positions are measured on `geometry` when given (unboosted coverage),
  // while the contour itself came from `field`.
  const g = geometry ?? field;
  const f = (px: number, py: number) => (px < -1 || py < -1 || px > W - 2 || py > H - 2 ? 0 : g[(py + 1) * W + px + 1]);
  // Two-level form: the window runs from a flat level A to a flat level B (not
  // necessarily 0 and 1, e.g. next to a corner where another edge cuts the
  // column), and the normalised sum gives the transition position.
  const solve = (sample: (i: number) => number, at: number): number | null => {
    for (let k = 1; k <= 3; k++) {
      const lo = at - k, hi = at + k;
      const A = sample(lo), B = sample(hi);
      if (Math.abs(B - A) < 0.3) continue;
      // Clean 0 → 1 (or 1 → 0) ends are already known plateau levels, so thin
      // strokes (whose far edge sits just past `hi`) still refine. Partial levels
      // (an edge cut by another near a corner) must be confirmed flat outside.
      const clean = (A <= 0.02 && B >= 0.98) || (A >= 0.98 && B <= 0.02);
      if (!clean && (Math.abs(sample(lo - 1) - A) > 0.03 || Math.abs(sample(hi + 1) - B) > 0.03)) continue;
      let sum = 0;
      for (let i = lo; i <= hi; i++) sum += Math.min(1, Math.max(0, (sample(i) - A) / (B - A)));
      return hi + 1 - sum;
    }
    return null;
  };

  // Thin-stroke model: when a stroke (or a gap) is narrower than the window, the
  // monotone form above cannot apply, as both edges fall inside it. The summed
  // coverage across the stroke is its exact width and the coverage centroid its
  // exact centre, so its edges are centre ± width/2, exact for any straight
  // thin line, even sub-pixel hairlines. Returns the edge nearest `target`.
  const solveThin = (sample: (i: number) => number, at: number, target: number): number | null => {
    for (let k = 1; k <= 4; k++) {
      const lo = at - k, hi = at + k;
      const A = sample(lo), B = sample(hi);
      const bump = A <= 0.03 && B <= 0.03;
      const dip = A >= 0.97 && B >= 0.97;
      if (!bump && !dip) continue;
      let sum = 0, moment = 0, peak = 0;
      for (let i = lo; i <= hi; i++) {
        const v = bump ? sample(i) : 1 - sample(i);
        sum += v;
        moment += (i + 0.5) * v;
        peak = Math.max(peak, v);
      }
      // One stroke = one run above half its own peak (faint lines peak below 50%).
      let crossings = 0, prev = 0;
      for (let i = lo; i <= hi; i++) {
        const v = bump ? sample(i) : 1 - sample(i);
        if ((prev < peak / 2) !== (v < peak / 2)) crossings++;
        prev = v;
      }
      if ((prev < peak / 2) !== (0 < peak / 2)) crossings++;
      if (sum < 0.05 || crossings !== 2) continue; // nothing there, or two strokes
      const centre = moment / sum;
      const e1 = centre - sum / 2, e2 = centre + sum / 2;
      return Math.abs(e1 - target) <= Math.abs(e2 - target) ? e1 : e2;
    }
    return null;
  };

  const out: Pt[] = [];
  for (const [x, y] of points) {
    const px = Math.floor(x), py = Math.floor(y);
    const gx = f(px + 1, py - 1) + 2 * f(px + 1, py) + f(px + 1, py + 1) - f(px - 1, py - 1) - 2 * f(px - 1, py) - f(px - 1, py + 1);
    const gy = f(px - 1, py + 1) + 2 * f(px, py + 1) + f(px + 1, py + 1) - f(px - 1, py - 1) - 2 * f(px, py - 1) - f(px + 1, py - 1);
    const horizontal = Math.abs(gy) >= Math.abs(gx);
    const onColumnCentre = Number.isInteger(x + 0.5);
    const onRowCentre = Number.isInteger(y + 0.5);
    let p: Pt | null = null;
    if (horizontal && onColumnCentre) {
      const col = (i: number) => f(px, i);
      let e = solve(col, py);
      if (e === null || Math.abs(e - y) >= 1.5) e = solveThin(col, py, y);
      if (e !== null && Math.abs(e - y) < 1.5) p = [x, e];
    } else if (!horizontal && onRowCentre) {
      const row = (i: number) => f(i, py);
      let e = solve(row, px);
      if (e === null || Math.abs(e - x) >= 1.5) e = solveThin(row, px, x);
      if (e !== null && Math.abs(e - x) < 1.5) p = [e, y];
    } else if ((horizontal && onRowCentre) || (!horizontal && onColumnCentre)) {
      continue; // redundant crossing for this edge direction
    }
    const q = p ?? [x, y];
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - q[0]) + Math.abs(last[1] - q[1]) > 1e-6) out.push(q);
  }
  return out.length >= 3 ? out : points;
}

export function signedArea(points: Pt[]): number {
  let s = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    s += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  }
  return s / 2;
}

export function pointInPolygon(x: number, y: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function bounds(points: Pt[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}
