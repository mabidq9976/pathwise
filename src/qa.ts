// Dev-only QA bench (open /qa.html under `npm run dev`). Traces every test image
// in every outline style and reports fidelity, size and smoothness metrics,
// plus source-vs-vector crops of each image's hardest regions.

import { EXAMPLES } from './examples.ts';
import { precisionTrace } from './precision/engine.ts';
import { measureFidelity } from './quality.ts';
import { PRESETS, profileImage, toPrecisionOptions, withOutline, type OutlineStyle } from './settings.ts';
import { Enhancer } from './upscale/client.ts';
import { countNodes, toSvg, type Seg, type VectorDoc } from './vector.ts';

interface Case {
  id: string;
  load: () => Promise<HTMLCanvasElement | null>;
  crops: Array<[number, number, number, number]>;
}

async function fromUrl(url: string): Promise<HTMLCanvasElement | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const bmp = await createImageBitmap(await res.blob());
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  return c;
}

const example = (id: string) => async () => EXAMPLES.find((e) => e.id === id)!.draw();

const CASES: Case[] = [
  { id: 'badge', load: example('badge'), crops: [[196, 404, 110, 60], [250, 170, 140, 110]] },
  { id: 'emblem', load: example('emblem'), crops: [[300, 180, 200, 50], [230, 590, 340, 35], [560, 100, 120, 120]] },
  { id: 'ink', load: example('ink'), crops: [[395, 70, 110, 90], [240, 105, 70, 95]] },
  { id: 'parrot', load: () => fromUrl('/samples/parrot.avif'), crops: [[340, 95, 130, 110], [170, 400, 80, 90], [405, 205, 80, 90]] },
  // Small symmetric details: domes, arched windows, sparkle stars.
  { id: 'nativity', load: () => fromUrl('/samples/nativity.png'), crops: [[545, 175, 140, 75], [1205, 440, 100, 75], [470, 410, 80, 60]] },
];

const STYLES: OutlineStyle[] = ['detailed', 'balanced', 'minimal'];

function shapeArea(segs: Seg[]): number {
  let a = 0, sx = 0, sy = 0, px = 0, py = 0, total = 0;
  for (const s of segs) {
    if (s.t === 'M') { total += a / 2; a = 0; sx = px = s.x; sy = py = s.y; continue; }
    const nx = s.t === 'Z' ? sx : s.x, ny = s.t === 'Z' ? sy : s.y;
    a += px * ny - nx * py;
    px = nx; py = ny;
  }
  return Math.abs(total + a / 2);
}

/** Anchors where two curves meet with a tangent break over 20° (lines excluded: those are corners by design). */
function curveKinks(doc: VectorDoc): number {
  let kinks = 0;
  for (const shape of doc.shapes) {
    let prev: Seg | null = null;
    let cur: [number, number] = [0, 0];
    for (const s of shape.segs) {
      if (s.t === 'C' && prev && prev.t === 'C') {
        const a: [number, number] = [prev.x - prev.x2, prev.y - prev.y2];
        const b: [number, number] = [s.x1 - cur[0], s.y1 - cur[1]];
        const ang = Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]));
        if (ang > (20 * Math.PI) / 180) kinks++;
      }
      if (s.t !== 'Z') cur = [s.x, s.y];
      prev = s.t === 'M' ? null : s;
    }
  }
  return kinks;
}

function crop(svgOrUrl: string, isSvg: boolean, w: number, h: number, [x, y, cw, ch]: [number, number, number, number], k: number): string {
  if (isSvg) {
    return svgOrUrl.replace(/<svg [^>]*>/, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${cw} ${ch}" style="width:${cw * k}px;height:${ch * k}px;background:#fff">`);
  }
  return `<div style="position:relative;width:${cw * k}px;height:${ch * k}px;overflow:hidden;background:#fff"><img src="${svgOrUrl}" style="position:absolute;left:${-x * k}px;top:${-y * k}px;width:${w * k}px;height:${h * k}px;image-rendering:pixelated"></div>`;
}

async function run() {
  const out = document.getElementById('out')!;
  const rows: string[] = [];
  const sections: string[] = [];
  for (const c of CASES) {
    const canvas = await c.load();
    if (!canvas) {
      rows.push(`<tr><td>${c.id}</td><td colspan="8">missing (put it in samples/)</td></tr>`);
      continue;
    }
    const { width: w, height: h } = canvas;
    const img = canvas.getContext('2d')!.getImageData(0, 0, w, h);
    const sample = img;
    const preset = profileImage(sample.data, w, h).preset;
    const base = PRESETS[preset].settings;
    const srcUrl = canvas.toDataURL();
    const svgs: Record<string, string> = {};
    for (const style of STYLES) {
      document.getElementById('status')!.textContent = `Tracing ${c.id} (${style})…`;
      await new Promise((r) => setTimeout(r, 0));
      const s = withOutline({ ...base, engine: 'precision' }, style);
      const t0 = performance.now();
      const doc = precisionTrace(img.data, w, h, toPrecisionOptions(s));
      const ms = performance.now() - t0;
      const fid = measureFidelity(doc, img.data, w, h);
      const specks = doc.shapes.filter((sh) => shapeArea(sh.segs) < 4).length;
      const kinks = curveKinks(doc);
      const svg = toSvg(doc, { width: w, height: h }, 3);
      svgs[style] = svg;
      rows.push(
        `<tr><td>${c.id}</td><td>${style}</td><td>${fid ? fid.match.toFixed(2) + '%' : '—'}</td><td>${doc.shapes.length}</td><td>${countNodes(doc)}</td>` +
          `<td class="${specks ? 'bad' : ''}">${specks}</td><td class="${kinks > countNodes(doc) * 0.03 ? 'bad' : ''}">${kinks}</td>` +
          `<td>${(svg.length / 1024).toFixed(1)} KB</td><td>${Math.round(ms)} ms</td></tr>`,
      );
    }
    const crops = c.crops
      .map((r) => {
        const k = Math.min(3, 260 / r[2]);
        return `<div class="crop"><div class="label">${c.id} @ ${r.join(',')} — source · detailed · balanced · minimal</div><div class="pair">${crop(srcUrl, false, w, h, r, k)}${STYLES.map((st) => crop(svgs[st], true, w, h, r, k)).join('')}</div></div>`;
      })
      .join('');
    sections.push(`<div class="crops">${crops}</div>`);
  }
  out.innerHTML =
    `<h2 style="font-size:15px">Styles</h2><table><thead><tr><th>image</th><th>style</th><th>match</th><th>shapes</th><th>nodes</th><th>specks &lt;4px²</th><th>curve kinks</th><th>svg</th><th>time</th></tr></thead><tbody>${rows.join('')}</tbody></table>` +
    sections.join('');
  await runEnhance(out);
  document.getElementById('status')!.textContent = 'Done.';
  (window as unknown as { __qa: string[] }).__qa = rows;
}

/**
 * Ground-truth check for the AI enhancer: crisp art is degraded the way real
 * images are (¼ size, JPEG q=0.55), traced with Enhance off / 2× / 4×, and each
 * result is scored against the original crisp art, so the enhancer must
 * recover the design, not merely match a blurry copy.
 */
async function runEnhance(out: HTMLElement) {
  const enhancer = new Enhancer();
  const rows: string[] = [];
  const crops: string[] = [];
  for (const id of ['badge', 'ink']) {
    const truth = EXAMPLES.find((e) => e.id === id)!.draw();
    const W = truth.width, H = truth.height;
    const truthData = truth.getContext('2d')!.getImageData(0, 0, W, H);
    const small = document.createElement('canvas');
    small.width = Math.round(W / 4);
    small.height = Math.round(H / 4);
    const sctx = small.getContext('2d')!;
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(truth, 0, 0, small.width, small.height);
    const jpeg = await new Promise<Blob>((r) => small.toBlob((b) => r(b!), 'image/jpeg', 0.55));
    const degraded = await createImageBitmap(jpeg);
    const preset = profileImage(truthData.data, W, H).preset;
    const svgs: string[] = [];
    for (const factor of [1, 2, 4] as const) {
      document.getElementById('status')!.textContent = `Enhance check: ${id} ${factor}×…`;
      await new Promise((r) => setTimeout(r, 0));
      let canvas: HTMLCanvasElement;
      const t0 = performance.now();
      if (factor === 1) {
        canvas = document.createElement('canvas');
        canvas.width = degraded.width;
        canvas.height = degraded.height;
        canvas.getContext('2d')!.drawImage(degraded, 0, 0);
      } else {
        canvas = await enhancer.enhance(degraded, factor);
      }
      const t1 = performance.now();
      const d = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
      const s = withOutline({ ...PRESETS[preset].settings, engine: 'precision' }, 'balanced');
      const doc = precisionTrace(d.data, d.width, d.height, toPrecisionOptions(s, canvas.width / degraded.width));
      const t2 = performance.now();
      const fid = measureFidelity(doc, truthData.data, W, H);
      svgs.push(toSvg(doc, { width: W, height: H }, 3));
      rows.push(
        `<tr><td>${id} (${degraded.width}×${degraded.height} JPEG)</td><td>${factor === 1 ? 'off' : factor + '×'}</td><td>${fid ? fid.match.toFixed(2) + '%' : '—'}</td>` +
          `<td>${doc.shapes.length}</td><td>${countNodes(doc)}</td><td>${Math.round(t1 - t0)} ms</td><td>${Math.round(t2 - t1)} ms</td></tr>`,
      );
    }
    const r: [number, number, number, number] = id === 'badge' ? [190, 395, 300, 85] : [230, 90, 260, 170];
    const k = Math.min(2, 520 / r[2]);
    const scaled = (svg: string) =>
      svg.replace(/<svg [^>]*>/, (m) => {
        const vb = m.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)!;
        const sx = Number(vb[1]) / W;
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r[0] * sx} ${r[1] * sx} ${r[2] * sx} ${r[3] * sx}" style="width:${r[2] * k}px;height:${r[3] * k}px;background:#fff">`;
      });
    crops.push(
      `<div class="crop"><div class="label">${id}: crisp truth · degraded input · traced off · 2× · 4×</div><div class="pair">` +
        crop(truth.toDataURL(), false, W, H, r, k) +
        `<div style="position:relative;width:${r[2] * k}px;height:${r[3] * k}px;overflow:hidden;background:#fff"><img src="${await blobUrl(jpeg)}" style="position:absolute;left:${-r[0] * k}px;top:${-r[1] * k}px;width:${W * k}px;height:${H * k}px;image-rendering:pixelated"></div>` +
        svgs.map(scaled).join('') +
        `</div></div>`,
    );
  }
  out.insertAdjacentHTML(
    'beforeend',
    `<h2 style="font-size:15px">AI enhance vs ground truth</h2><table><thead><tr><th>input</th><th>enhance</th><th>match vs crisp original</th><th>shapes</th><th>nodes</th><th>enhance</th><th>trace</th></tr></thead><tbody>${rows.join('')}</tbody></table><div class="crops">${crops.join('')}</div>`,
  );
  (window as unknown as { __qaEnhance: string[] }).__qaEnhance = rows;
}

function blobUrl(b: Blob): Promise<string> {
  return new Promise((r) => {
    const fr = new FileReader();
    fr.onload = () => r(String(fr.result));
    fr.readAsDataURL(b);
  });
}

run();
