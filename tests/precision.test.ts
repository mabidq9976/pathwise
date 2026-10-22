import assert from 'node:assert/strict';
import { test } from 'node:test';
import { precisionTrace, type PrecisionOptions } from '../src/precision/engine.ts';
import { PRESETS, toPrecisionOptions } from '../src/settings.ts';
import { palette, type Seg } from '../src/vector.ts';

const OPTS: PrecisionOptions = {
  stacking: 'stacked',
  binary: false,
  colorTolerance: 0.04,
  maxColors: 0,
  minArea: 1,
  cornerAngle: 30,
  fitTolerance: 0.2,
};

type Inside = (x: number, y: number) => boolean;

/**
 * Anti-aliased render blended in sRGB like a canvas. N×N supersampling: 32 is
 * near-exact; 4 quantises coverage to 1/16 like Chrome's canvas (±0.25 px noise).
 */
function render(w: number, h: number, bg: number[], layers: Array<[number[], Inside]>, N = 32) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let col = [...bg];
      for (const [fg, inside] of layers) {
        let hit = 0;
        for (let sy = 0; sy < N; sy++) for (let sx = 0; sx < N; sx++) if (inside(x + (sx + 0.5) / N, y + (sy + 0.5) / N)) hit++;
        const t = hit / (N * N);
        col = col.map((c, i) => c * (1 - t) + fg[i] * t);
      }
      data.set([...col.map(Math.round), 255], (y * w + x) * 4);
    }
  }
  return data;
}

const anchors = (segs: Seg[]) => segs.flatMap((s) => (s.t === 'Z' ? [] : [[s.x, s.y] as [number, number]]));
const near = (pts: Array<[number, number]>, x: number, y: number) => Math.min(...pts.map(([px, py]) => Math.hypot(px - x, py - y)));

test('off-grid rectangle becomes four exact lines', () => {
  const [x0, y0, x1, y1] = [12.3, 9.7, 61.6, 38.2];
  const data = render(80, 50, [255, 255, 255], [[[30, 60, 200], (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1]]);
  const doc = precisionTrace(data, 80, 50, OPTS);
  const rect = doc.shapes.find((s) => s.fill !== '#ffffff')!;
  assert.ok(rect, 'blue rectangle missing');
  assert.equal(doc.shapes.length, 2, `expected background + rectangle, got ${doc.shapes.length}`);
  assert.deepEqual(rect.segs.map((s) => s.t), ['M', 'L', 'L', 'L', 'L', 'Z']);
  const pts = anchors(rect.segs);
  for (const [cx, cy] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
    const d = near(pts, cx, cy);
    assert.ok(d < 0.06, `corner (${cx}, ${cy}) off by ${d.toFixed(3)}px`);
  }
});

test('rotated square keeps sharp corners', () => {
  const c = [40, 40], half = 18, a = (25 * Math.PI) / 180;
  const inside: Inside = (x, y) => {
    const dx = x - c[0], dy = y - c[1];
    const u = dx * Math.cos(a) + dy * Math.sin(a), v = -dx * Math.sin(a) + dy * Math.cos(a);
    return Math.abs(u) <= half && Math.abs(v) <= half;
  };
  const doc = precisionTrace(render(80, 80, [250, 250, 250], [[[200, 30, 40], inside]]), 80, 80, OPTS);
  const sq = doc.shapes.find((s) => s.fill !== '#fafafa')!;
  assert.deepEqual(sq.segs.map((s) => s.t), ['M', 'L', 'L', 'L', 'L', 'Z']);
  const pts = anchors(sq.segs);
  for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const x = c[0] + half * (u * Math.cos(a) - v * Math.sin(a)), y = c[1] + half * (u * Math.sin(a) + v * Math.cos(a));
    const d = near(pts, x, y);
    assert.ok(d < 0.08, `corner off by ${d.toFixed(3)}px`);
  }
});

test('anti-aliased circle is recognised as a circle', () => {
  const [cx, cy, r] = [50.4, 40.7, 20.3];
  const doc = precisionTrace(render(100, 80, [255, 255, 255], [[[20, 20, 20], (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r]]), 100, 80, OPTS);
  const circle = doc.shapes.find((s) => s.fill !== '#ffffff')!;
  const curves = circle.segs.filter((s) => s.t === 'C');
  assert.equal(curves.length, 4, `expected a 4-arc circle, got ${curves.length} curves`);
  for (const [x, y] of anchors(circle.segs)) {
    const err = Math.abs(Math.hypot(x - cx, y - cy) - r);
    assert.ok(err < 0.08, `anchor ${err.toFixed(3)}px off the true circle`);
  }
});

test('large circle from a coarse rasteriser stays a true circle', () => {
  const [cx, cy, r] = [130.3, 120.6, 104.2];
  const data = render(260, 240, [255, 255, 255], [[[29, 53, 87], (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r]], 4);
  const doc = precisionTrace(data, 260, 240, toPrecisionOptions(PRESETS.logo.settings));
  const circle = doc.shapes.find((s) => s.fill !== '#ffffff')!;
  assert.equal(circle.segs.filter((s) => s.t === 'C').length, 4, `got ${circle.segs.map((s) => s.t).join('')}`);
  for (const [x, y] of anchors(circle.segs)) assert.ok(Math.abs(Math.hypot(x - cx, y - cy) - r) < 0.15);
});

test('ring keeps its hole and blends never become colours', () => {
  const [cx, cy] = [40, 40];
  const doc = precisionTrace(
    render(80, 80, [255, 255, 255], [[[230, 57, 70], (x, y) => { const d = Math.hypot(x - cx, y - cy); return d <= 30 && d >= 15; }]]),
    80, 80, OPTS,
  );
  assert.equal(palette(doc).length, 2, `palette: ${palette(doc).map((p) => p.color)}`);
  const ring = doc.shapes.find((s) => s.fill !== '#ffffff')!;
  assert.equal(ring.segs.filter((s) => s.t === 'M').length, 2, 'ring needs an outer contour and a hole');
});

test('badge-like art: close colours stay apart and straight edges stay single lines', () => {
  // White page, red disc, cream bar and yellow triangle on the disc. White and
  // cream are close (Oklab ~0.03), which used to merge them and make edges wobble.
  const tri: Array<[number, number]> = [[60, 30], [95, 85], [28, 78]];
  const inTri: Inside = (x, y) => {
    const s = (p: [number, number], q: [number, number]) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
    const d1 = s(tri[0], tri[1]), d2 = s(tri[1], tri[2]), d3 = s(tri[2], tri[0]);
    return (d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0);
  };
  const data = render(140, 140, [255, 255, 255], [
    [[230, 57, 70], (x, y) => (x - 70) ** 2 + (y - 70) ** 2 <= 62 ** 2],
    [[241, 250, 238], (x, y) => x >= 40.4 && x <= 100.2 && y >= 95.3 && y <= 112.6],
    [[255, 209, 102], inTri],
  ]);
  const doc = precisionTrace(data, 140, 140, toPrecisionOptions(PRESETS.logo.settings));
  const colors = palette(doc).map((p) => p.color);
  assert.ok(colors.includes('#f1faee') && colors.includes('#ffffff'), `cream merged into white: ${colors}`);
  const yellow = doc.shapes.find((s) => s.fill === '#ffd166')!;
  assert.deepEqual(yellow.segs.map((s) => s.t), ['M', 'L', 'L', 'L', 'Z'], 'triangle should be three straight edges');
  for (const [x, y] of tri) { const d = near(anchors(yellow.segs), x, y); assert.ok(d < 0.15, `triangle corner (${x}, ${y}) off by ${d.toFixed(3)}px; anchors ${JSON.stringify(anchors(yellow.segs).map((p) => p.map((v) => +v.toFixed(2))))}`); }
  const cream = doc.shapes.find((s) => s.fill === '#f1faee')!;
  assert.deepEqual(cream.segs.map((s) => s.t), ['M', 'L', 'L', 'L', 'L', 'Z'], 'cream bar should be four straight edges');
});

test('star from a coarse (Chrome-like) rasteriser keeps ten straight edges', () => {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 52 : 120, a = (Math.PI / 5) * i - Math.PI / 2;
    pts.push([150 + Math.cos(a) * r, 140 + Math.sin(a) * r]);
  }
  const inStar: Inside = (x, y) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const data = render(300, 280, [230, 57, 70], [[[255, 209, 102], inStar]], 4);
  const doc = precisionTrace(data, 300, 280, toPrecisionOptions(PRESETS.logo.settings));
  const star = doc.shapes.find((s) => s.fill === '#ffd166')!;
  assert.deepEqual(star.segs.map((s) => s.t), ['M', ...Array(10).fill('L'), 'Z'], `got ${star.segs.map((s) => s.t).join('')}`);
  for (const [x, y] of pts) {
    const d = near(anchors(star.segs), x, y);
    assert.ok(d < 0.35, `star vertex (${x.toFixed(1)}, ${y.toFixed(1)}) off by ${d.toFixed(3)}px`);
  }
});

test('tiny star (9 px radius) keeps all ten points sharp', () => {
  const stars = [[24, 24], [61.3, 23.6], [23.4, 60.7]].map(([cx, cy]) =>
    Array.from({ length: 10 }, (_, i) => {
      const r = i % 2 ? 3.8 : 9, a = (Math.PI / 5) * i - Math.PI / 2;
      return [cx + Math.cos(a) * r, cy + Math.sin(a) * r] as [number, number];
    }),
  );
  const inPoly = (pts: Array<[number, number]>): Inside => (x, y) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const data = render(88, 88, [251, 246, 236], [[[38, 70, 83], (x, y) => stars.some((p) => inPoly(p)(x, y))]], 4);
  const doc = precisionTrace(data, 88, 88, toPrecisionOptions(PRESETS.logo.settings));
  const shapes = doc.shapes.filter((s) => s.fill === '#264653');
  assert.equal(shapes.length, 3);
  const all = shapes.flatMap((s) => anchors(s.segs));
  for (const pts of stars) {
    for (const [x, y] of pts) {
      const d = near(all, x, y);
      assert.ok(d < 0.6, `star vertex (${x.toFixed(1)}, ${y.toFixed(1)}) off by ${d.toFixed(3)}px`);
    }
  }
});

/** Anchors where the outgoing tangent turns by more than `deg` from the incoming one. */
function kinks(segs: Seg[], deg: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = 0;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].t !== 'Z') continue;
    const sub = segs.slice(start, i); // M ... (without Z)
    const pts: Array<[number, number]> = sub.map((s) => [(s as any).x, (s as any).y]);
    const n = sub.length - 1; // drawing segments
    const tanIn = (k: number): [number, number] => {
      const s = sub[k] as any, prev = pts[k - 1];
      return s.t === 'C' ? [s.x - s.x2, s.y - s.y2] : [s.x - prev[0], s.y - prev[1]];
    };
    const tanOut = (k: number): [number, number] => {
      const s = sub[k] as any, prev = pts[k - 1];
      return s.t === 'C' ? [s.x1 - prev[0], s.y1 - prev[1]] : [s.x - prev[0], s.y - prev[1]];
    };
    for (let k = 1; k <= n; k++) {
      const a = tanIn(k), b = tanOut(k === n ? 1 : k + 1);
      const ang = Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1])) * (180 / Math.PI);
      if (ang > deg) out.push(pts[k]);
    }
    start = i + 1;
  }
  return out;
}

test('a leaf traces as smooth curves with no flat sides', () => {
  // Leaf sides as designers draw them: Bézier curves that bulge near the base
  // and taper to the tip. Rendered like Chrome's canvas, with and without a
  // slight edge ripple (as upscaled images have), at 1× and at 2.67× with the
  // enhanced-image options. Gently bending stretches used to come out as
  // straight lines, which read as flat, angular sides.
  type P = [number, number];
  const bez = (p0: P, p1: P, p2: P, p3: P, t: number): P => {
    const u = 1 - t;
    return [0, 1].map((k) => u * u * u * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t * t * t * p3[k]) as P;
  };
  const leaf: P[] = [];
  for (let i = 0; i <= 80; i++) leaf.push(bez([0, 0], [10, -16], [38, -16], [60, 0], i / 80));
  for (let i = 1; i < 80; i++) leaf.push(bez([60, 0], [42, 13], [14, 15], [0, 0], i / 80));
  for (const scale of [1, 8 / 3]) {
    for (const ripple of [0, 0.25]) {
      const rot = (25 * Math.PI) / 180, w = Math.ceil(85 * scale), h = Math.ceil(60 * scale);
      const poly = leaf.map(([x, y]): P => [14 * scale + 0.3 + scale * (x * Math.cos(rot) - y * Math.sin(rot)), 22 * scale + 0.2 + scale * (x * Math.sin(rot) + y * Math.cos(rot))]);
      const inPoly = (x: number, y: number) => {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const [xi, yi] = poly[i], [xj, yj] = poly[j];
          if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
      };
      const wobble = (x: number, y: number) => ripple * Math.sin(x * 2.1 + y * 1.3);
      const data = render(w, h, [255, 255, 255], [[[0, 0, 0], (x, y) => inPoly(x + wobble(x, y), y - wobble(x, y))]], 4);
      const doc = precisionTrace(data, w, h, toPrecisionOptions(PRESETS.bw.settings, scale));
      assert.equal(doc.shapes.length, 1);
      const segs = doc.shapes[0].segs;
      let prev: P = [0, 0];
      const flats: number[] = [];
      for (const sg of segs) {
        if (sg.t === 'Z') continue;
        const l = Math.hypot(sg.x - prev[0], sg.y - prev[1]);
        if (sg.t === 'L' && l > 0.08 * 60 * scale) flats.push(l);
        prev = [sg.x, sg.y];
      }
      const tag = `scale ${scale.toFixed(2)}, ripple ${ripple}`;
      assert.equal(flats.length, 0, `${tag}: flat sides ${flats.map((f) => f.toFixed(1))} px in ${segs.map((sg) => sg.t).join('')}`);
      // The point stays sharp.
      const tip: P = [14 * scale + 0.3 + scale * 60 * Math.cos(rot), 22 * scale + 0.2 + scale * 60 * Math.sin(rot)];
      const corners = kinks(segs, 30);
      assert.ok(corners.some((c) => near([c], tip[0], tip[1]) < 1.5 * scale), `${tag}: tip not sharp; corners at ${JSON.stringify(corners)}`);
    }
  }
});

test('U letterform: stems flow smoothly into the bowl, only the stem tops are corners', () => {
  const inU: Inside = (x, y) => {
    const outer = (x >= 20 && x <= 60 && y >= 10 && y <= 50) || (x - 40) ** 2 + (y - 50) ** 2 <= 400;
    const counter = (x >= 30 && x <= 50 && y >= 10 && y <= 50) || (x - 40) ** 2 + (y - 50) ** 2 <= 100;
    return outer && !counter;
  };
  const data = render(80, 80, [230, 57, 70], [[[241, 250, 238], inU]], 4);
  const doc = precisionTrace(data, 80, 80, toPrecisionOptions(PRESETS.logo.settings));
  const u = doc.shapes.find((s) => s.fill === '#f1faee')!;
  const sharp = kinks(u.segs, 12);
  assert.equal(sharp.length, 4, `expected 4 stem-top corners, got ${JSON.stringify(sharp.map((p) => p.map((v) => +v.toFixed(1))))}`);
  for (const [, y] of sharp) assert.ok(Math.abs(y - 10) < 0.5, 'a kink away from the stem tops');
  // The counter must be round: its straight sides stop where the radius-10
  // bowl begins (y = 50), not lower, which would flatten the bowl.
  const lineEnds = u.segs.filter((s) => s.t === 'L' && (Math.abs(s.x - 30) < 0.6 || Math.abs(s.x - 50) < 0.6) && s.y > 30);
  assert.ok(lineEnds.length >= 1, 'inner stems should be straight lines');
  for (const s of lineEnds) assert.ok(s.t === 'L' && s.y <= 51.2, `inner stem runs into the bowl down to y=${s.t === 'L' ? s.y.toFixed(2) : ''}`);
});

test('thin stroke with round caps traces as a smooth capsule', () => {
  // 4.4 px wide diagonal stroke with round caps, like a pen line.
  const [ax, ay, bx, by, r] = [18.3, 22.7, 71.6, 49.2, 2.2];
  const inStroke: Inside = (x, y) => {
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - ax - t * dx, y - ay - t * dy) <= r;
  };
  const data = render(90, 70, [255, 255, 255], [[[17, 17, 17], inStroke]], 4);
  const doc = precisionTrace(data, 90, 70, toPrecisionOptions(PRESETS.bw.settings));
  const stroke = doc.shapes[0];
  const sharp = kinks(stroke.segs, 15);
  assert.equal(sharp.length, 0, `caps should be smooth, kinks at ${JSON.stringify(sharp.map((p) => p.map((v) => +v.toFixed(1))))}`);
  // Both cap tips stay where the pen ended. Sample along the curves: a round
  // cap's tip lies mid-curve, not on an anchor.
  const pts: Array<[number, number]> = [];
  let cur: [number, number] = [0, 0];
  for (const s of stroke.segs) {
    if (s.t === 'M' || s.t === 'L') cur = [s.x, s.y];
    if (s.t === 'C') {
      for (let k = 1; k <= 16; k++) {
        const t = k / 16, u = 1 - t;
        pts.push([
          u * u * u * cur[0] + 3 * u * u * t * s.x1 + 3 * u * t * t * s.x2 + t * t * t * s.x,
          u * u * u * cur[1] + 3 * u * u * t * s.y1 + 3 * u * t * t * s.y2 + t * t * t * s.y,
        ]);
      }
      cur = [s.x, s.y];
    }
    if (s.t !== 'Z') pts.push(cur);
  }
  const tip = (cx: number, cy: number, ux: number, uy: number) => Math.max(...pts.map(([x, y]) => (x - cx) * ux + (y - cy) * uy));
  const L = Math.hypot(bx - ax, by - ay), ux = (bx - ax) / L, uy = (by - ay) / L;
  const endTip = tip(bx, by, ux, uy), startTip = tip(ax, ay, -ux, -uy);
  assert.ok(Math.abs(endTip - r) < 0.35, `end cap tip off by ${(endTip - r).toFixed(3)}px`);
  assert.ok(Math.abs(startTip - r) < 0.35, `start cap tip off by ${(startTip - r).toFixed(3)}px`);
});

test('curved stroke drawn as straight facets traces as one smooth curve', () => {
  // A quadratic curve flattened into 7 straight pieces (as browsers do before
  // rasterising), stroked 7 px wide with round caps and joins.
  const quad = (t: number): [number, number] => {
    const u = 1 - t;
    return [u * u * 20 + 2 * u * t * 95 + t * t * 185, u * u * 95 + 2 * u * t * 5 + t * t * 85];
  };
  const poly = Array.from({ length: 8 }, (_, k) => quad(k / 7));
  const half = 3.5;
  const inStroke: Inside = (x, y) => {
    for (let k = 0; k + 1 < poly.length; k++) {
      const [ax, ay] = poly[k], [bx, by] = poly[k + 1];
      const dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
      if (Math.hypot(x - ax - t * dx, y - ay - t * dy) <= half) return true;
    }
    return false;
  };
  const data = render(205, 110, [255, 255, 255], [[[17, 17, 17], inStroke]], 4);
  const doc = precisionTrace(data, 205, 110, toPrecisionOptions(PRESETS.bw.settings));
  const stroke = doc.shapes[0];
  const bends = kinks(stroke.segs, 8);
  assert.equal(bends.length, 0, `stroke sides should be smooth, bends at ${JSON.stringify(bends.map((p) => p.map((v) => +v.toFixed(1))))}`);
  const lines = stroke.segs.filter((s) => s.t === 'L').length;
  assert.ok(lines <= 2, `facets kept as ${lines} straight lines`);
});

test('1.5 px hairline keeps its true width without wobble', () => {
  // Thin strokes put both edges inside one refinement window; the thin-stroke
  // model (width = summed coverage, centre = coverage centroid) handles them.
  const [ax, ay, bx, by, half] = [10, 20.3, 150, 29.1, 0.75];
  const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy), nx = -dy / L, ny = dx / L;
  const inLine: Inside = (x, y) => {
    const t = ((x - ax) * dx + (y - ay) * dy) / (L * L);
    return t >= 0 && t <= 1 && Math.abs((x - ax) * nx + (y - ay) * ny) <= half;
  };
  const data = render(160, 45, [251, 246, 236], [[[20, 69, 61], inLine]]);
  const doc = precisionTrace(data, 160, 45, toPrecisionOptions(PRESETS.logo.settings));
  const line = doc.shapes.find((sh) => sh.fill !== '#fbf6ec')!;
  assert.ok(line, 'hairline missing');
  // Sample the outline away from the ends and measure distance to the centreline.
  const offs: number[] = [];
  let cur: [number, number] = [0, 0];
  for (const sg of line.segs) {
    const pts: Array<[number, number]> = [];
    if (sg.t === 'L') for (let k = 1; k <= 30; k++) pts.push([cur[0] + ((sg.x - cur[0]) * k) / 30, cur[1] + ((sg.y - cur[1]) * k) / 30]);
    if (sg.t === 'C') {
      for (let k = 1; k <= 30; k++) {
        const t = k / 30, u = 1 - t;
        pts.push([u * u * u * cur[0] + 3 * u * u * t * sg.x1 + 3 * u * t * t * sg.x2 + t * t * t * sg.x, u * u * u * cur[1] + 3 * u * u * t * sg.y1 + 3 * u * t * t * sg.y2 + t * t * t * sg.y]);
      }
    }
    for (const [x, y] of pts) {
      const t = ((x - ax) * dx + (y - ay) * dy) / (L * L);
      if (t > 0.08 && t < 0.92) offs.push(Math.abs((x - ax) * nx + (y - ay) * ny));
    }
    if (sg.t !== 'Z') cur = [sg.x, sg.y];
  }
  const mean = offs.reduce((a, b) => a + b, 0) / offs.length;
  const spread = Math.max(...offs.map((o) => Math.abs(o - mean)));
  assert.ok(Math.abs(mean - half) < 0.06, `half-width ${mean.toFixed(3)} vs ${half}`);
  assert.ok(spread < 0.12, `edge wobble ±${spread.toFixed(3)} px`);
});

/** Soft, slightly noisy input like a downscaled/compressed drawing: two 3×3 box blurs + ±6 luma noise. */
function soften(data: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
  let cur = Float32Array.from(data);
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float32Array(cur.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 4; c++) {
          let sum = 0, cnt = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < w && yy < h) { sum += cur[(yy * w + xx) * 4 + c]; cnt++; }
          }
          next[(y * w + x) * 4 + c] = sum / cnt;
        }
      }
    }
    cur = next;
  }
  const out = new Uint8ClampedArray(data.length);
  let seed = 7;
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = i % 4 === 3 ? 255 : Math.round(cur[i] + ((seed / 0x7fffffff) * 12 - 6));
  }
  return out;
}

test('soft, noisy dot is still traced as an exact circle', () => {
  const [cx, cy, r] = [40.3, 38.6, 9.2];
  const data = soften(render(80, 80, [255, 255, 255], [[[10, 10, 10], (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r]], 4), 80, 80);
  const doc = precisionTrace(data, 80, 80, toPrecisionOptions(PRESETS.bw.settings));
  const dot = doc.shapes[0];
  assert.deepEqual(dot.segs.map((s) => s.t), ['M', 'C', 'C', 'C', 'C', 'Z'], `got ${dot.segs.map((s) => s.t).join('')}`);
  for (const [x, y] of anchors(dot.segs)) assert.ok(Math.abs(Math.hypot(x - cx, y - cy) - r) < 0.35, 'off the true circle');
});

test('soft tapered stroke keeps its sharp point', () => {
  // Thin wedge (14° at the tip) like a pen or feather stroke; blur blunts its end.
  const [tx, ty] = [130, 46];
  const inWedge: Inside = (x, y) => x >= 20 && x <= tx && Math.abs(y - ty) <= ((tx - x) * Math.tan((7 * Math.PI) / 180));
  const data = soften(render(150, 90, [255, 255, 255], [[[10, 10, 10], inWedge]], 4), 150, 90);
  const doc = precisionTrace(data, 150, 90, toPrecisionOptions(PRESETS.bw.settings));
  const pts = anchors(doc.shapes[0].segs);
  const d = near(pts, tx, ty);
  // The true point is ~3.5 px beyond where the blurred stroke visibly ends.
  assert.ok(d < 1.5, `tip rebuilt ${d.toFixed(2)} px from the true point`);
});

test('cutout mode produces non-overlapping regions', () => {
  const data = render(60, 40, [255, 255, 255], [[[0, 0, 0], (x) => x >= 30.5]]);
  const doc = precisionTrace(data, 60, 40, { ...OPTS, stacking: 'cutout' });
  assert.equal(doc.shapes.length, 2);
  const white = anchors(doc.shapes.find((s) => s.fill === '#ffffff')!.segs);
  assert.ok(Math.max(...white.map((p) => p[0])) < 30.6, 'white region should stop at the shared edge');
});
