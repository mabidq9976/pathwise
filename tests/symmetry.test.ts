import assert from 'node:assert/strict';
import { test } from 'node:test';
import { precisionTrace } from '../src/precision/engine.ts';
import { symmetrize } from '../src/precision/symmetry.ts';
import { PRESETS, toPrecisionOptions } from '../src/settings.ts';
import { flatten } from '../src/vector.ts';

type V = [number, number];

/** Deterministic noise in [−0.5, 0.5). */
function noise(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
}

function polyline(verts: V[], amount: number, seed = 1): V[] {
  const rnd = noise(seed);
  const pts: V[] = [];
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i], b = verts[(i + 1) % verts.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.8));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      pts.push([a[0] + (b[0] - a[0]) * t + rnd() * amount, a[1] + (b[1] - a[1]) * t + rnd() * amount]);
    }
  }
  return pts;
}

const segDist = (p: V, a: V, b: V) => {
  const ab: V = [b[0] - a[0], b[1] - a[1]];
  const l2 = ab[0] ** 2 + ab[1] ** 2;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t);
};
const distTo = (p: V, verts: V[]) => Math.min(...verts.map((a, i) => segDist(p, a, verts[(i + 1) % verts.length])));
const meanDist = (pts: V[], verts: V[]) => pts.reduce((s, p) => s + distTo(p, verts), 0) / pts.length;

/** 90th-percentile distance of `pts` mirrored about the best vertical axis near `guess` to `ring`. */
function asymmetry(pts: V[], ring: V[], guess: number): number {
  let best = Infinity;
  for (let cx = guess - 0.5; cx <= guess + 0.5; cx += 0.02) {
    const d = pts.map((p) => distTo([2 * cx - p[0], p[1]], ring)).sort((a, b) => a - b);
    best = Math.min(best, d[Math.floor(d.length * 0.9)]);
  }
  return best;
}

/** Arched window: semicircle on a rectangle, as a dense polygon. */
function arch(cx: number, top: number, r: number, bottom: number): V[] {
  const v: V[] = [];
  for (let i = 0; i <= 40; i++) {
    const a = Math.PI + (Math.PI * i) / 40;
    v.push([cx + r * Math.cos(a), top + r + r * Math.sin(a)]);
  }
  v.push([cx + r, bottom], [cx - r, bottom]);
  return v;
}

test('noisy symmetric shapes come out closer to the true outline', () => {
  const star: V[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 52 : 120, a = (Math.PI / 5) * i - Math.PI / 2;
    star.push([150 + Math.cos(a) * r, 140 + Math.sin(a) * r]);
  }
  for (const [name, verts] of [['star', star], ['arch', arch(50, 10, 10, 55)]] as Array<[string, V[]]>) {
    const pts = polyline(verts, 0.2);
    const out = symmetrize(pts, { tolerance: 0.5, minSpan: 4 }).pts;
    assert.notEqual(out, pts, `${name}: no symmetry found`);
    const before = meanDist(pts, verts), after = meanDist(out, verts);
    assert.ok(after < before * 0.85, `${name}: mean error ${before.toFixed(3)} → ${after.toFixed(3)}`);
  }
});

test('an asymmetric triangle is left alone', () => {
  const pts = polyline([[60, 30], [95, 85], [28, 78]], 0.25, 3);
  assert.equal(symmetrize(pts, { tolerance: 0.5, minSpan: 4 }).pts, pts);
});

test('a lopsided dome is made exactly symmetric', () => {
  // Semicircular dome whose right half bulges 0.4 px: within tolerance.
  const verts: V[] = [];
  for (let i = 0; i <= 60; i++) {
    const a = Math.PI + (Math.PI * i) / 60;
    const bulge = Math.cos(a) > 0 ? 0.4 * Math.sin(-a) : 0;
    verts.push([40 + (20 + bulge) * Math.cos(a), 40 + (20 + bulge) * Math.sin(a)]);
  }
  verts.push([60, 60], [20, 60]);
  const pts = polyline(verts, 0.05, 5);
  const out = symmetrize(pts, { tolerance: 0.5, minSpan: 4 }).pts;
  // Mirrored about its own axis, every point lands back on the outline.
  const before = asymmetry(pts, pts, 40), after = asymmetry(out, out, 40);
  assert.ok(before > 0.15, `test dome should start lopsided (${before.toFixed(3)}px)`);
  assert.ok(after < 0.06, `asymmetry ${before.toFixed(3)} → ${after.toFixed(3)}px`);
});

test('a lopsided dome traces as a symmetric curve', () => {
  // Dome on a wall, rendered like Chrome's canvas (coarse coverage), with its
  // right half 0.35 px wider, the way upscalers leave small domes.
  const w = 80, h = 70, cx = 40.3, r = 18;
  const rr = (x: number) => (x > cx ? r + 0.35 : r);
  const inside = (x: number, y: number) => (y >= 30 && y < 62 && Math.abs(x - cx) < rr(x)) || (y < 30 && (x - cx) ** 2 + (y - 30) ** 2 < rr(x) ** 2);
  const data = new Uint8ClampedArray(w * h * 4);
  const N = 4;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let hit = 0;
      for (let sy = 0; sy < N; sy++) for (let sx = 0; sx < N; sx++) if (inside(x + (sx + 0.5) / N, y + (sy + 0.5) / N)) hit++;
      const v = Math.round(255 * (1 - hit / (N * N)));
      data.set([v, v, v, 255], (y * w + x) * 4);
    }
  }
  const doc = precisionTrace(data, w, h, toPrecisionOptions(PRESETS.bw.settings));
  assert.equal(doc.shapes.length, 1);
  const ring = flatten(doc.shapes[0].segs, 0.05)[0];
  const asym = asymmetry(ring.filter(([, y]) => y < 30), ring, cx + 0.17);
  assert.ok(asym < 0.1, `dome asymmetry ${asym.toFixed(3)}px`);
});
