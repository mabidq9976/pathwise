import './styles.css';
import { EXAMPLES } from './examples.ts';
import { OUTLINE_STYLES, PRESETS, profileImage, toPrecisionOptions, toTracerConfig, withOutline, type EnhanceMode, type OutlineStyle, type PresetId, type TraceSettings } from './settings.ts';
import { measureFidelity } from './quality.ts';
import { analyzeResolution } from './resolution.ts';
import { Enhancer } from './upscale/client.ts';
import { CancelledError, Tracer } from './tracer.ts';
import type { Fidelity } from './quality.ts';
import { countNodes, palette, toDxf, toEps, toPdf, toSvg, type VectorDoc } from './vector.ts';
import { Viewer, type ViewMode } from './viewer.ts';

const MAX_FILE_BYTES = 40 * 1024 * 1024;
const MAX_PNG_SIDE = 16384;
const MAX_PNG_AREA = 120_000_000;

interface Source {
  name: string;
  url: string;
  width: number;
  height: number;
  bitmap: ImageBitmap;
}

type PresetChoice = 'auto' | PresetId | 'custom';

interface SliderSpec {
  key: keyof TraceSettings;
  label: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  hint: string;
  format?: (value: number) => string;
}

const SLIDERS: SliderSpec[] = [
  { key: 'maxColors', label: 'Max colours', min: 0, max: 64, step: 1, hint: 'Upper limit on palette size (Precision engine). Auto keeps every distinct colour.', format: (v) => (v === 0 ? 'Auto' : String(v)) },
  { key: 'colorPrecision', label: 'Colour detail', min: 1, max: 8, step: 1, hint: 'How finely colours are told apart. Lower merges similar colours together.' },
  { key: 'layerDifference', label: 'Gradient step', min: 0, max: 128, step: 1, hint: 'Minimum colour difference between layers. Higher gives fewer, flatter layers.' },
  { key: 'filterSpeckle', label: 'Remove specks', min: 0, max: 16, step: 1, unit: 'px', hint: 'Patches smaller than this are dropped.' },
  { key: 'cornerThreshold', label: 'Corner angle', min: 0, max: 180, step: 1, unit: '°', hint: 'Turns sharper than this stay as corners; gentler turns become curves.' },
  { key: 'lengthThreshold', label: 'Smoothness', min: 2, max: 10, step: 0.5, hint: 'Higher allows curves to deviate more from the bitmap, giving fewer nodes.' },
  { key: 'spliceThreshold', label: 'Splice angle', min: 0, max: 180, step: 1, unit: '°', hint: 'Angle at which a curve is split into separate splines.' },
  { key: 'pathPrecision', label: 'Decimals', min: 0, max: 6, step: 1, hint: 'Decimal places written per coordinate. Lower makes smaller files.' },
  { key: 'maxDimension', label: 'Trace size', min: 256, max: 8192, step: 128, unit: 'px', hint: 'Longest side the bitmap is scaled to before tracing. Larger is more detailed but slower.' },
];

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const viewer = new Viewer($('#viewer'));
const tracer = new Tracer();
const enhancer = new Enhancer();

let source: Source | null = null;
let imageCache: { key: string; data: ImageData; scale: number } | null = null;
let originalCache: ImageData | null = null;
let settings: TraceSettings = { ...PRESETS.logo.settings };
let presetChoice: PresetChoice = 'auto';
let autoPreset: PresetId = 'logo';
let autoReason = '';
let doc: VectorDoc | null = null;
let svgMarkup = '';
let traceMs = 0;
let fidelity: Fidelity | null = null;
let traceSeq = 0;
let highlighted: string | null = null;
let viewMode: ViewMode = 'split';

// ---------------------------------------------------------------------------
// Loading

async function loadImage(blob: Blob, name: string) {
  if (blob.type && !blob.type.startsWith('image/')) return toast('That file is not an image.');
  if (blob.size > MAX_FILE_BYTES) return toast('That image is over 40 MB.');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return toast('Could not read that image. Try PNG, JPG, WebP, AVIF, GIF or BMP.');
  }
  if (source) {
    URL.revokeObjectURL(source.url);
    source.bitmap.close();
  }
  source = { name, url: URL.createObjectURL(blob), width: bitmap.width, height: bitmap.height, bitmap };
  imageCache = null;
  originalCache = null;
  doc = null;
  svgMarkup = '';
  highlighted = null;

  const sample = rasterize(bitmap, 400);
  const profile = profileImage(sample.data, sample.width, sample.height);
  autoPreset = profile.preset;
  autoReason = profile.reason;

  showEditor(true);
  $('#file-meta').textContent = `${name} · ${bitmap.width} × ${bitmap.height}`;
  viewer.setImage(source.url, bitmap.width, bitmap.height);
  viewer.highlight(null);
  renderPalette();
  renderStats();
  choosePreset('auto');
}

function rasterize(bitmap: ImageBitmap | HTMLCanvasElement, maxDimension: number): ImageData {
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

const ENHANCE_FACTOR: Record<EnhanceMode, 1 | 2 | 4> = { off: 1, x2: 2, x4: 4 };

/**
 * Pixels to trace: the original, or its AI-enhanced (×2/×4) version, capped at
 * the trace size (at least 4096 px when enhanced, so the upscale is not undone).
 * `scale` is trace pixels per real image pixel: the enhance factor, or, for an
 * image that was enlarged before it reached us (blocky or soft edges), the
 * enlargement the Precision engine should smooth over.
 */
async function traceInput(): Promise<{ data: ImageData; scale: number }> {
  const src = source!;
  const factor = ENHANCE_FACTOR[settings.enhance];
  const cap = factor > 1 ? Math.max(settings.maxDimension, 4096) : settings.maxDimension;
  const native = factor === 1 && settings.engine === 'precision';
  const key = `${factor}:${cap}:${native}`;
  if (imageCache?.key !== key) {
    let base: ImageBitmap | HTMLCanvasElement = src.bitmap;
    if (factor > 1) {
      setBusy(true, 'Enhancing on your GPU…');
      base = await enhancer.enhance(src.bitmap, factor as 2 | 4, (done, total) => setBusy(true, `Enhancing on your GPU… ${done}/${total}`));
      setBusy(true);
    }
    let data = rasterize(base, cap);
    let scale = factor > 1 ? data.width / src.width : 1;
    if (native) {
      const res = analyzeResolution(data.data, data.width, data.height);
      if (res.reason !== 'native') {
        if (res.data !== data.data) data = new ImageData(res.data, data.width, data.height);
        scale = res.scale;
      }
    }
    imageCache = { key, data, scale };
  }
  return imageCache;
}

/** The original pixels (≤ 1600 px), for scoring an enhanced trace against what the user loaded. */
function originalPixels(): ImageData {
  return (originalCache ??= rasterize(source!.bitmap, 1600));
}

// ---------------------------------------------------------------------------
// Tracing

async function retrace() {
  if (!source) return;
  const seq = ++traceSeq;
  setBusy(true);
  try {
    const input = await traceInput();
    if (seq !== traceSeq) return;
    const out = await tracer.trace(
      input.data,
      settings.engine === 'precision'
        ? { engine: 'precision', options: toPrecisionOptions(settings, input.scale) }
        : { engine: 'classic', config: toTracerConfig(settings) },
    );
    if (seq !== traceSeq) return;
    doc = out.doc;
    traceMs = out.ms;
    // Enhanced traces are scored against the original, not the upscale.
    if (settings.enhance !== 'off') {
      const ref = originalPixels();
      fidelity = measureFidelity(doc, ref.data, ref.width, ref.height);
    } else {
      fidelity = out.fidelity;
    }
    svgMarkup = toSvg(doc, { width: source.width, height: source.height }, settings.pathPrecision);
    if (highlighted && !doc.shapes.some((s) => s.fill === highlighted)) highlighted = null;
    viewer.setVector(svgMarkup, doc.width);
    viewer.highlight(highlighted);
    renderPalette();
    renderStats();
  } catch (err) {
    if (err instanceof CancelledError || seq !== traceSeq) return;
    const message = err instanceof Error ? err.message : String(err);
    if (settings.enhance !== 'off' && /WebGPU|adapter|GPU|Model/i.test(message)) {
      settings = { ...settings, enhance: 'off' };
      syncControls();
      toast(`Enhance unavailable: ${message}. Tracing without it.`);
      retraceSoon(0);
      return;
    }
    toast(`Tracing failed: ${message}`);
  } finally {
    if (seq === traceSeq) setBusy(false);
  }
}

let debounce = 0;
function retraceSoon(delay = 220) {
  clearTimeout(debounce);
  debounce = window.setTimeout(retrace, delay);
}

// ---------------------------------------------------------------------------
// Settings UI

function choosePreset(choice: PresetChoice) {
  presetChoice = choice;
  if (choice !== 'custom') {
    const id = choice === 'auto' ? autoPreset : choice;
    settings = { ...withOutline({ ...PRESETS[id].settings }, settings.outline), enhance: settings.enhance };
  }
  syncControls();
  retraceSoon(0);
}

/** Outline style layers on the current preset; with custom settings it only overrides its own fields. */
function chooseOutline(outline: OutlineStyle) {
  if (presetChoice === 'custom') settings = withOutline(settings, outline);
  else settings = { ...settings, outline };
  if (presetChoice !== 'custom') return choosePreset(presetChoice);
  syncControls();
  retraceSoon(0);
}

/** Enhance is a pre-pass on the image, independent of the preset. */
function chooseEnhance(enhance: EnhanceMode) {
  if (settings.enhance === enhance) return;
  settings = { ...settings, enhance };
  syncControls();
  retraceSoon(0);
}

function updateSetting<K extends keyof TraceSettings>(key: K, value: TraceSettings[K], delay?: number) {
  if (settings[key] === value) return;
  settings = { ...settings, [key]: value };
  presetChoice = 'custom';
  syncControls();
  retraceSoon(delay);
}

function buildControls() {
  const chips = $('#presets');
  const choices: Array<[PresetChoice, string]> = [['auto', 'Auto'], ...Object.entries(PRESETS).map(([id, p]) => [id as PresetId, p.label] as [PresetChoice, string])];
  for (const [id, label] of choices) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.dataset.preset = id;
    b.textContent = label;
    b.addEventListener('click', () => choosePreset(id));
    chips.append(b);
  }

  document.querySelectorAll<HTMLElement>('.seg[data-setting]').forEach((seg) => {
    const key = seg.dataset.setting as 'engine' | 'colorMode' | 'hierarchical' | 'mode' | 'outline' | 'enhance';
    seg.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-value]');
      if (!b || b.disabled) return;
      if (key === 'outline') chooseOutline(b.dataset.value as OutlineStyle);
      else if (key === 'enhance') chooseEnhance(b.dataset.value as EnhanceMode);
      else updateSetting(key, b.dataset.value as never, 0);
    });
  });

  const host = $('#sliders');
  for (const spec of SLIDERS) {
    const row = document.createElement('label');
    row.className = 'slider';
    row.title = spec.hint;
    row.innerHTML = `<span class="slider-head"><span>${spec.label}</span><output></output></span>
      <input type="range" min="${spec.min}" max="${spec.max}" step="${spec.step}" data-key="${spec.key}">`;
    const input = row.querySelector('input')!;
    input.addEventListener('input', () => updateSetting(spec.key, Number(input.value) as never));
    host.append(row);
  }

  $('#reset').addEventListener('click', () => choosePreset('auto'));

  $('#view-mode').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-value]');
    if (b) setViewMode(b.dataset.value as ViewMode);
  });
}

function syncControls() {
  document.querySelectorAll<HTMLButtonElement>('#presets .chip').forEach((b) => {
    const active = b.dataset.preset === presetChoice;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
    if (b.dataset.preset === 'auto') b.textContent = `Auto · ${PRESETS[autoPreset].label}`;
  });
  $('#preset-hint').textContent =
    presetChoice === 'auto' ? `Detected: ${autoReason.toLowerCase()}.` : presetChoice === 'custom' ? 'Custom settings.' : '';
  $('#outline-hint').textContent = settings.engine === 'precision' ? OUTLINE_STYLES[settings.outline].hint : 'Outline styles apply to the Precision engine.';
  const small = source ? Math.max(source.width, source.height) <= 1200 : false;
  $('#enhance-hint').textContent =
    settings.enhance !== 'off'
      ? 'Real-ESRGAN upscale on your GPU before tracing; Match is scored against your original.'
      : small
        ? 'Suggested for this image: 2× sharpens small, soft or compressed art before tracing.'
        : 'AI upscale (local, on your GPU) for small, soft or compressed images.';

  const binary = settings.colorMode === 'binary';
  const precision = settings.engine === 'precision';
  const spline = precision || settings.mode === 'spline';
  const disabled: Partial<Record<keyof TraceSettings, boolean>> = {
    colorPrecision: binary,
    layerDifference: binary || precision,
    hierarchical: binary,
    mode: precision,
    outline: !precision,
    maxColors: binary || !precision,
    cornerThreshold: !spline,
    lengthThreshold: !spline,
    spliceThreshold: !spline || precision,
  };

  document.querySelectorAll<HTMLElement>('.seg[data-setting]').forEach((seg) => {
    const key = seg.dataset.setting as keyof TraceSettings;
    seg.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.setAttribute('aria-checked', String(b.dataset.value === settings[key]));
      b.disabled = !!disabled[key];
    });
  });

  document.querySelectorAll<HTMLInputElement>('#sliders input').forEach((input) => {
    const spec = SLIDERS.find((s) => s.key === input.dataset.key)!;
    const value = settings[spec.key] as number;
    input.value = String(value);
    input.disabled = !!disabled[spec.key];
    input.closest('.slider')!.classList.toggle('disabled', input.disabled);
    input.closest('.slider')!.querySelector('output')!.textContent = spec.format ? spec.format(value) : `${value}${spec.unit ?? ''}`;
  });
}

function setViewMode(mode: ViewMode) {
  viewMode = mode;
  viewer.setMode(mode);
  document.querySelectorAll<HTMLButtonElement>('#view-mode button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === mode)));
}

// ---------------------------------------------------------------------------
// Palette and stats

function renderPalette() {
  const host = $('#palette');
  host.replaceChildren();
  const entries = doc ? palette(doc) : [];
  $('#palette-count').textContent = entries.length ? String(entries.length) : '';
  for (const entry of entries.slice(0, 96)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.setAttribute('role', 'listitem');
    b.style.setProperty('--c', entry.color);
    b.title = `${entry.color} · ${entry.shapes} shape${entry.shapes === 1 ? '' : 's'}`;
    b.setAttribute('aria-label', b.title);
    b.setAttribute('aria-pressed', String(entry.color === highlighted));
    b.addEventListener('click', () => {
      highlighted = highlighted === entry.color ? null : entry.color;
      viewer.highlight(highlighted);
      if (highlighted && viewMode === 'original') setViewMode('vector');
      renderPalette();
    });
    host.append(b);
  }
}

function renderStats() {
  const rows: Array<[string, string]> = doc
    ? [
        ['Match', fidelity ? `${fidelity.match.toFixed(1)}%` : '—'],
        ['Shapes', doc.shapes.length.toLocaleString()],
        ['Nodes', countNodes(doc).toLocaleString()],
        ['SVG size', formatBytes(new Blob([svgMarkup]).size)],
        ['Traced at', `${doc.width} × ${doc.height}`],
        ['Trace time', `${Math.round(traceMs)} ms`],
      ]
    : [];
  $('#stats').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// ---------------------------------------------------------------------------
// Export

function baseName() {
  const stem = (source?.name ?? 'image').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${stem || 'image'}-vector`;
}

function save(data: BlobPart, type: string, ext: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${baseName()}.${ext}`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function svgToPng(svg: string, width: number, height: number, scale: number): Promise<Blob> {
  let s = scale;
  while (s > 0.25 && (width * s > MAX_PNG_SIDE || height * s > MAX_PNG_SIDE || width * height * s * s > MAX_PNG_AREA)) s /= 2;
  if (s !== scale) toast(`PNG reduced to ${s}× to stay within browser canvas limits.`);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * s);
    canvas.height = Math.round(height * s);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function exportAs(kind: string) {
  if (!doc || !source) return toast('Wait for the trace to finish first.');
  const size = { width: source.width, height: source.height };
  try {
    switch (kind) {
      case 'svg': return save(svgMarkup, 'image/svg+xml', 'svg');
      case 'pdf': return save((await toPdf(doc, size)) as BlobPart, 'application/pdf', 'pdf');
      case 'eps': return save(toEps(doc, size, baseName()), 'application/postscript', 'eps');
      case 'dxf': return save(toDxf(doc, size), 'application/dxf', 'dxf');
      case 'png': {
        const scale = Number($<HTMLSelectElement>('#png-scale').value);
        return save(await svgToPng(svgMarkup, size.width, size.height, scale), 'image/png', 'png');
      }
    }
  } catch (err) {
    toast(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Page chrome

function showEditor(show: boolean) {
  $('#landing').hidden = show;
  $('#editor').hidden = !show;
  $('#new-image').hidden = !show;
  document.body.classList.toggle('editing', show);
}

function setBusy(busy: boolean, label = 'Tracing…') {
  $('#busy').hidden = !busy;
  $('#busy-label').textContent = label;
  $('#viewer').classList.toggle('stale', busy && !!doc);
}

let toastTimer = 0;
function toast(message: string) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 4500);
}

function buildExamples() {
  const grid = $('#example-grid');
  for (const ex of EXAMPLES) {
    const canvas = ex.draw();
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'example';
    b.innerHTML = `<img alt="" src="${canvas.toDataURL('image/png')}"><span>${ex.label}</span>`;
    b.addEventListener('click', () => canvas.toBlob((blob) => blob && loadImage(blob, `${ex.id}.png`), 'image/png'));
    grid.append(b);
  }
}

function bindInputs() {
  const fileInput = $<HTMLInputElement>('#file');
  $('#dropzone').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) loadImage(file, file.name);
    fileInput.value = '';
  });

  $('#new-image').addEventListener('click', () => {
    clearTimeout(debounce);
    traceSeq++;
    setBusy(false);
    showEditor(false);
  });

  const overlay = $('#drop-overlay');
  let depth = 0;
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    overlay.hidden = false;
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.hidden = true;
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const file = e.dataTransfer!.files[0];
    if (file) loadImage(file, file.name);
  });

  window.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.kind === 'file' && i.type.startsWith('image/'));
    const file = item?.getAsFile();
    if (!file) return;
    e.preventDefault();
    loadImage(file, file.name && file.name !== 'image.png' ? file.name : 'pasted.png');
  });

  document.querySelectorAll<HTMLButtonElement>('[data-export]').forEach((b) => b.addEventListener('click', () => exportAs(b.dataset.export!)));

  window.addEventListener('keydown', (e) => {
    if ($('#editor').hidden || e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement).closest('input, select, textarea')) return;
    const modes: Record<string, ViewMode> = { '1': 'original', '2': 'split', '3': 'vector', '4': 'outlines' };
    if (modes[e.key]) setViewMode(modes[e.key]);
    if (e.key === 'f') viewer.fit();
  });
}

buildControls();
buildExamples();
bindInputs();
setViewMode('split');
// Desktop app (Electron): everything still runs locally, just not in a browser.
if (navigator.userAgent.includes('Electron')) {
  const pill = document.getElementById('privacy-pill');
  if (pill) pill.textContent = 'Private · runs on your computer';
}

syncControls();
