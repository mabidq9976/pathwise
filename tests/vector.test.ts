import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { precisionTrace } from '../src/precision/engine.ts';
import { profileImage, PRESETS, toPrecisionOptions, toTracerConfig } from '../src/settings.ts';
import { countNodes, flatten, fmt, nearestAci, palette, parsePathData, parseTracerSvg, toDxf, toEps, toPdf, toSvg } from '../src/vector.ts';

const pkgDir = dirname(createRequire(import.meta.url).resolve('vtracer-wasm/package.json'));
const vtracer = await import(join(pkgDir, 'vtracer.js'));
vtracer.initSync({ module: readFileSync(join(pkgDir, 'vtracer.wasm')) });

/** 120×80 image: blue left half, white right half, red disc in the middle. */
function sampleImage() {
  const w = 120, h = 80;
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const disc = (x - 60) ** 2 + (y - 40) ** 2 < 25 ** 2;
      const c = disc ? [220, 40, 40] : x < 60 ? [30, 90, 200] : [250, 250, 250];
      px.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
    }
  }
  return { px, w, h };
}

function traceSample() {
  const { px, w, h } = sampleImage();
  return vtracer.to_svg(px, w, h, toTracerConfig(PRESETS.logo.settings)) as string;
}

test('fmt trims zeros and negative zero', () => {
  assert.equal(fmt(1.5, 2), '1.5');
  assert.equal(fmt(2, 2), '2');
  assert.equal(fmt(-0.001, 2), '0');
  assert.equal(fmt(3.14159, 0), '3');
});

test('parsePathData resolves relative, H/V, Q and offsets', () => {
  const segs = parsePathData('m1 2 l3 0 h1 v2 Q10 10 12 4 z', 10, 20);
  assert.deepEqual(segs[0], { t: 'M', x: 11, y: 22 });
  assert.deepEqual(segs[1], { t: 'L', x: 14, y: 22 });
  assert.deepEqual(segs[2], { t: 'L', x: 15, y: 22 });
  assert.deepEqual(segs[3], { t: 'L', x: 15, y: 24 });
  assert.equal(segs[4].t, 'C');
  if (segs[4].t === 'C') assert.deepEqual([segs[4].x, segs[4].y], [22, 24]);
  assert.deepEqual(segs[5], { t: 'Z' });
});

test('implicit linetos after moveto', () => {
  const segs = parsePathData('M0 0 10 0 10 10Z');
  assert.deepEqual(segs.map((s) => s.t), ['M', 'L', 'L', 'Z']);
});

test('tracer output parses with translate baked in', () => {
  const svg = traceSample();
  const doc = parseTracerSvg(svg);
  assert.equal(doc.width, 120);
  assert.equal(doc.height, 80);
  assert.ok(doc.shapes.length >= 3, `expected >= 3 shapes, got ${doc.shapes.length}`);
  const colors = palette(doc).map((p) => p.color);
  for (const c of ['#1e5ac8', '#fafafa', '#dc2828']) assert.ok(colors.includes(c), `missing ${c} in ${colors}`);
  // The red disc must land around the image centre once its translate is applied.
  const disc = doc.shapes.find((s) => s.fill === '#dc2828')!;
  const xs = disc.segs.flatMap((s) => (s.t === 'Z' ? [] : [s.x]));
  assert.ok(Math.min(...xs) > 30 && Math.max(...xs) < 90, `disc x-range ${Math.min(...xs)}..${Math.max(...xs)}`);
});

test('square corners survive spline fitting', () => {
  const w = 64, h = 64;
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = x >= 16 && x < 48 && y >= 16 && y < 48;
      px.set(inside ? [220, 40, 40, 255] : [250, 250, 250, 255], (y * w + x) * 4);
    }
  }
  const doc = parseTracerSvg(vtracer.to_svg(px, w, h, toTracerConfig(PRESETS.logo.settings)));
  for (const shape of doc.shapes) {
    const pts = shape.segs.flatMap((s) => (s.t === 'C' ? [[s.x1, s.y1], [s.x2, s.y2], [s.x, s.y]] : s.t === 'Z' ? [] : [[s.x, s.y]]));
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    // Control points of a square stay inside its bounds; a rounded/lens fit overshoots.
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    assert.ok(x0 >= 0 && y0 >= 0 && x1 <= w && y1 <= h, `${shape.fill} overshoots: ${x0},${y0}..${x1},${y1}`);
  }
});

test('every preset traces a gradient without crashing; photo/poster keep its colours', () => {
  const w = 200, h = 120;
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = y / h;
      px.set([40 + 200 * t, 45 + 70 * t, 110 - 20 * t, 255].map(Math.round), (y * w + x) * 4);
    }
  }
  for (const [id, preset] of Object.entries(PRESETS)) {
    const doc =
      preset.settings.engine === 'precision'
        ? precisionTrace(new Uint8ClampedArray(px.buffer), w, h, toPrecisionOptions(preset.settings))
        : parseTracerSvg(vtracer.to_svg(px, w, h, toTracerConfig(preset.settings)));
    const colors = palette(doc).length;
    // Logo and B&W intentionally flatten a smooth gradient to very few fills.
    const min = id === 'photo' || id === 'poster' ? 3 : 1;
    assert.ok(colors >= min, `${id}: only ${colors} colour(s)`);
  }
});

test('speckle filter removes patches up to its size', () => {
  const w = 200, h = 200;
  const px = new Uint8Array(w * h * 4).fill(255);
  for (let i = 0; i < 10; i++) {
    for (let j = 0; j < 10; j++) {
      for (let dy = 0; dy < 3; dy++) {
        for (let dx = 0; dx < 3; dx++) px.set([0, 0, 0, 255], ((10 + j * 18 + dy) * w + 10 + i * 18 + dx) * 4);
      }
    }
  }
  const count = (speckle: number) =>
    parseTracerSvg(vtracer.to_svg(px, w, h, toTracerConfig({ ...PRESETS.logo.settings, filterSpeckle: speckle }))).shapes.length;
  assert.equal(count(2), 101); // 3×3 dots are larger than 2×2
  assert.equal(count(3), 1); // ...and gone at 3×3
});

test('toSvg round-trips through the parser', () => {
  const doc = parseTracerSvg(traceSample());
  const svg = toSvg(doc, { width: 240, height: 160 }, 3);
  assert.match(svg, /viewBox="0 0 120 80"/);
  assert.match(svg, /width="240" height="160"/);
  const again = parseTracerSvg(svg.replace('width="240" height="160"', 'width="120" height="80"'));
  assert.equal(again.shapes.length, doc.shapes.length);
  assert.equal(countNodes(again), countNodes(doc));
});

test('PDF xref offsets point at their objects', async () => {
  const doc = parseTracerSvg(traceSample());
  for (const compress of [false, true]) {
    const bytes = await toPdf(doc, { width: 120, height: 80 }, compress);
    const text = new TextDecoder('latin1').decode(bytes);
    assert.ok(text.startsWith('%PDF-1.4'));
    const startxref = Number(text.match(/startxref\n(\d+)/)![1]);
    assert.ok(text.slice(startxref).startsWith('xref'));
    const entries = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    assert.equal(entries.length, 5);
    entries.forEach((off, i) => assert.ok(text.slice(off).startsWith(`${i + 1} 0 obj`), `object ${i + 1} at ${off}`));
    if (compress) assert.match(text, /\/Filter \/FlateDecode/);
    else assert.match(text, / rg\n/);
  }
});

test('EPS has a bounding box and one fill per shape', () => {
  const doc = parseTracerSvg(traceSample());
  const eps = toEps(doc, { width: 120.5, height: 80 }, 'x');
  assert.match(eps, /^%!PS-Adobe-3\.0 EPSF-3\.0/);
  assert.match(eps, /%%BoundingBox: 0 0 121 80/);
  assert.equal(eps.match(/^f$/gm)!.length, doc.shapes.length);
});

test('DXF has paired group codes and one polyline per ring', () => {
  const doc = parseTracerSvg(traceSample());
  const dxf = toDxf(doc, { width: 120, height: 80 });
  const lines = dxf.trimEnd().split('\n');
  assert.equal(lines.length % 2, 0);
  assert.deepEqual(lines.slice(-2), ['0', 'EOF']);
  const rings = doc.shapes.reduce((n, s) => n + flatten(s.segs).length, 0);
  assert.equal(dxf.match(/^POLYLINE$/gm)!.length, rings);
});

test('nearestAci maps primaries to named colours', () => {
  assert.equal(nearestAci('#ff0000'), 1);
  assert.equal(nearestAci('#0000ff'), 5);
  assert.equal(nearestAci('#000000'), 250);
});

test('profileImage picks a preset that fits the image', () => {
  const { px, w, h } = sampleImage();
  assert.equal(profileImage(new Uint8ClampedArray(px.buffer), w, h).preset, 'pixel');
  const big = new Uint8ClampedArray(400 * 300 * 4);
  for (let i = 0; i < big.length; i += 4) {
    const v = (i / 4) % 400 < 200 ? 0 : 255;
    big.set([v, v, v, 255], i);
  }
  assert.equal(profileImage(big, 400, 300).preset, 'bw');
});
