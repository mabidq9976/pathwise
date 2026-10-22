// Zoomable, pannable comparison view: original bitmap, vector result, a split
// slider between them, or vector outlines drawn over the bitmap.

export type ViewMode = 'original' | 'split' | 'vector' | 'outlines';

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 64;

export class Viewer {
  private stage: HTMLDivElement;
  private original: HTMLImageElement;
  private vector: HTMLDivElement;
  private highlightStyle: HTMLStyleElement;
  private splitLine: HTMLDivElement;
  private zoomLabel: HTMLButtonElement;

  private z = 1;
  private tx = 0;
  private ty = 0;
  private fitted = true;
  private splitX = 0.5; // fraction of viewer width
  private mode: ViewMode = 'split';
  private imgW = 0;
  private imgH = 0;
  private traceW = 0;

  constructor(private root: HTMLElement) {
    root.classList.add('viewer');
    root.innerHTML = `
      <div class="stage">
        <img class="layer original" alt="Original bitmap" draggable="false">
        <div class="layer vector" aria-label="Vector result"></div>
      </div>
      <div class="split-line" hidden><button class="split-knob" type="button" aria-label="Drag to compare original and vector"></button></div>
      <span class="view-tag left" hidden>Original</span>
      <span class="view-tag right" hidden>Vector</span>
      <div class="zoom-ctl" role="group" aria-label="Zoom">
        <button type="button" data-zoom="out" aria-label="Zoom out">−</button>
        <button type="button" data-zoom="actual" class="zoom-label" title="Actual size">100%</button>
        <button type="button" data-zoom="in" aria-label="Zoom in">+</button>
        <button type="button" data-zoom="fit" title="Fit to view">Fit</button>
      </div>`;
    this.stage = root.querySelector('.stage')!;
    this.original = root.querySelector('.original')!;
    this.vector = root.querySelector('.vector')!;
    this.splitLine = root.querySelector('.split-line')!;
    this.zoomLabel = root.querySelector('.zoom-label')!;
    this.highlightStyle = document.createElement('style');

    root.querySelector('.zoom-ctl')!.addEventListener('click', (e) => {
      const action = (e.target as HTMLElement).closest<HTMLElement>('[data-zoom]')?.dataset.zoom;
      const r = root.getBoundingClientRect();
      if (action === 'in') this.zoomAt(this.z * 1.5, r.width / 2, r.height / 2);
      if (action === 'out') this.zoomAt(this.z / 1.5, r.width / 2, r.height / 2);
      if (action === 'actual') this.zoomAt(1, r.width / 2, r.height / 2);
      if (action === 'fit') this.fit();
    });
    this.bindPointer();
    new ResizeObserver(() => (this.fitted ? this.fit() : this.apply())).observe(root);
  }

  setImage(src: string, width: number, height: number) {
    this.imgW = width;
    this.imgH = height;
    this.original.src = src;
    this.stage.style.width = `${width}px`;
    this.stage.style.height = `${height}px`;
    this.vector.innerHTML = '';
    this.fit();
  }

  setVector(svgMarkup: string, traceWidth: number) {
    this.traceW = traceWidth;
    this.vector.innerHTML = svgMarkup;
    this.vector.prepend(this.highlightStyle);
    this.apply();
  }

  setMode(mode: ViewMode) {
    this.mode = mode;
    this.apply();
  }

  highlight(color: string | null) {
    this.highlightStyle.textContent = color
      ? `svg path:not([fill="${color}"]){opacity:.07} svg path[fill="${color}"]{stroke:var(--accent);stroke-width:var(--sw);paint-order:stroke}`
      : '';
  }

  fit() {
    const r = this.root.getBoundingClientRect();
    if (!this.imgW || !r.width || !r.height) return;
    const pad = 24;
    this.z = Math.min((r.width - pad * 2) / this.imgW, (r.height - pad * 2) / this.imgH, 4);
    this.tx = (r.width - this.imgW * this.z) / 2;
    this.ty = (r.height - this.imgH * this.z) / 2;
    this.fitted = true;
    this.apply();
  }

  zoomAt(next: number, cx: number, cy: number) {
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    this.tx = cx - ((cx - this.tx) * z) / this.z;
    this.ty = cy - ((cy - this.ty) * z) / this.z;
    this.z = z;
    this.fitted = false;
    this.apply();
  }

  private apply() {
    const r = this.root.getBoundingClientRect();
    this.stage.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.z})`;
    this.zoomLabel.textContent = `${Math.round(this.z * 100)}%`;
    this.original.classList.toggle('pixelated', this.z >= 2);

    const showOriginal = this.mode !== 'vector';
    const showVector = this.mode !== 'original';
    this.original.style.visibility = showOriginal ? 'visible' : 'hidden';
    this.vector.style.visibility = showVector ? 'visible' : 'hidden';
    this.vector.classList.toggle('outlines', this.mode === 'outlines');

    // Stroke widths are in SVG user units (trace pixels); keep them ~1.25 screen px.
    const unitsPerScreenPx = this.traceW && this.imgW ? this.traceW / this.imgW / this.z : 1;
    this.vector.style.setProperty('--sw', String(1.25 * unitsPerScreenPx));

    const split = this.mode === 'split';
    this.splitLine.hidden = !split;
    this.root.querySelectorAll<HTMLElement>('.view-tag').forEach((t) => (t.hidden = !split));
    if (split) {
      const lineX = this.splitX * r.width;
      this.splitLine.style.left = `${lineX}px`;
      const local = Math.max(0, Math.min(this.imgW, (lineX - this.tx) / this.z));
      this.vector.style.clipPath = `inset(0 0 0 ${local}px)`;
    } else {
      this.vector.style.clipPath = '';
    }
  }

  private bindPointer() {
    let drag: { kind: 'pan' | 'split'; x: number; y: number; tx: number; ty: number } | null = null;
    this.root.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('.zoom-ctl')) return;
      const kind = (e.target as HTMLElement).closest('.split-line') ? 'split' : 'pan';
      drag = { kind, x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty };
      this.root.setPointerCapture(e.pointerId);
      this.root.classList.add(kind === 'pan' ? 'panning' : 'splitting');
    });
    this.root.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (drag.kind === 'pan') {
        this.tx = drag.tx + e.clientX - drag.x;
        this.ty = drag.ty + e.clientY - drag.y;
        this.fitted = false;
      } else {
        const r = this.root.getBoundingClientRect();
        this.splitX = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      }
      this.apply();
    });
    const end = () => {
      drag = null;
      this.root.classList.remove('panning', 'splitting');
    };
    this.root.addEventListener('pointerup', end);
    this.root.addEventListener('pointercancel', end);
    this.root.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const r = this.root.getBoundingClientRect();
        const speed = e.ctrlKey ? 0.01 : 0.0015; // ctrl+wheel is a trackpad pinch
        this.zoomAt(this.z * Math.exp(-e.deltaY * speed), e.clientX - r.left, e.clientY - r.top);
      },
      { passive: false },
    );
    this.splitLine.querySelector('button')!.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowLeft' ? -0.02 : e.key === 'ArrowRight' ? 0.02 : 0;
      if (!step) return;
      e.preventDefault();
      this.splitX = Math.max(0, Math.min(1, this.splitX + step));
      this.apply();
    });
  }
}
