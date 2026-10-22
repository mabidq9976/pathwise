import assert from 'node:assert/strict';
import { test } from 'node:test';
import { precisionTrace } from '../src/precision/engine.ts';
import { analyzeResolution, detectBlockSize, edgeWidth } from '../src/resolution.ts';
import { PRESETS, toPrecisionOptions } from '../src/settings.ts';

/** Anti-aliased black disc on white (16×16 supersampling). */
function disc(w: number, h: number, cx: number, cy: number, r: number) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let hit = 0;
      for (let sy = 0; sy < 16; sy++) for (let sx = 0; sx < 16; sx++) if ((x + (sx + 0.5) / 16 - cx) ** 2 + (y + (sy + 0.5) / 16 - cy) ** 2 < r * r) hit++;
      const v = Math.round(255 * (1 - hit / 256));
      data.set([v, v, v, 255], (y * w + x) * 4);
    }
  }
  return data;
}

function enlarge(src: Uint8ClampedArray, w: number, h: number, k: number, smooth: boolean) {
  const out = new Uint8ClampedArray(w * k * h * k * 4);
  for (let y = 0; y < h * k; y++) {
    for (let x = 0; x < w * k; x++) {
      const fx = smooth ? Math.min(w - 1, Math.max(0, (x + 0.5) / k - 0.5)) : Math.floor(x / k);
      const fy = smooth ? Math.min(h - 1, Math.max(0, (y + 0.5) / k - 0.5)) : Math.floor(y / k);
      const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
      for (let c = 0; c < 4; c++) {
        const at = (xx: number, yy: number) => src[(yy * w + xx) * 4 + c];
        out[(y * w * k + x) * 4 + c] = (at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) + (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty;
      }
    }
  }
  return out;
}

const scene = () => {
  // Several discs so there are enough edges to measure.
  const w = 60, h = 50, data = new Uint8ClampedArray(w * h * 4).fill(255);
  for (const [cx, cy, r] of [[15.3, 14.6, 9.2], [42.7, 17.1, 7.4], [28.2, 35.8, 10.6]]) {
    const d = disc(w, h, cx, cy, r);
    for (let i = 0; i < d.length; i++) data[i] = Math.min(data[i], d[i]);
  }
  return { data, w, h };
};

test('crisp anti-aliased art is left at native resolution', () => {
  const { data, w, h } = scene();
  const big = disc(400, 300, 200.3, 149.6, 120.4);
  assert.equal(detectBlockSize(big, 400, 300), 1);
  assert.ok(edgeWidth(big, 400, 300) < 2.5);
  assert.equal(analyzeResolution(big, 400, 300).reason, 'native');
  assert.equal(detectBlockSize(data, w, h), 1);
});

test('nearest-neighbour and smooth enlargements are detected', () => {
  const { data, w, h } = scene();
  assert.equal(detectBlockSize(enlarge(data, w, h, 6, false), w * 6, h * 6), 6);
  const soft = analyzeResolution(enlarge(data, w, h, 5, true), w * 5, h * 5);
  assert.equal(soft.reason, 'soft');
  assert.ok(soft.scale > 3.5 && soft.scale < 7.5, `soft scale ${soft.scale}`);
});

test('a blocky enlarged disc traces as a smooth circle, not a staircase', () => {
  const w = 40, h = 40, k = 8;
  const big = enlarge(disc(w, h, 20.2, 19.7, 13.3), w, h, k, false);
  const res = analyzeResolution(big, w * k, h * k);
  assert.equal(res.reason, 'blocky');
  const doc = precisionTrace(res.data, w * k, h * k, toPrecisionOptions(PRESETS.bw.settings, res.scale));
  assert.equal(doc.shapes.length, 1);
  const segs = doc.shapes[0].segs;
  assert.ok(segs.every((s) => s.t !== 'L'), `staircase lines left: ${segs.map((s) => s.t).join('')}`);
  assert.ok(segs.length <= 8, `${segs.length} segments`);
  // Centre and radius survive the round trip.
  const xs = segs.filter((s) => s.t !== 'Z').map((s) => (s as { x: number }).x);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, r = (Math.max(...xs) - Math.min(...xs)) / 2;
  assert.ok(Math.abs(cx - 20.2 * k) < 3, `centre ${cx}`);
  assert.ok(Math.abs(r - 13.3 * k) < 3, `radius ${r}`);
});
