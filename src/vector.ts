// Vector document model: parses the tracer's SVG into shapes with absolute
// coordinates, and writes them back out as SVG, EPS, PDF and DXF. No DOM use,
// so it runs in tests and workers too.

export type Seg =
  | { t: 'M'; x: number; y: number }
  | { t: 'L'; x: number; y: number }
  | { t: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { t: 'Z' };

export interface Shape {
  fill: string;
  segs: Seg[];
}

export interface VectorDoc {
  /** Size of the traced coordinate space. */
  width: number;
  height: number;
  shapes: Shape[];
}

export interface OutputSize {
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Parsing

const ATTR_RE = /([\w:-]+)\s*=\s*"([^"]*)"/g;

function attrs(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of source.matchAll(ATTR_RE)) out[m[1]] = m[2];
  return out;
}

export function parseTracerSvg(svg: string): VectorDoc {
  const root = svg.match(/<svg\b([^>]*)>/);
  if (!root) throw new Error('Tracer returned no <svg> element');
  const rootAttrs = attrs(root[1]);
  const width = parseFloat(rootAttrs.width);
  const height = parseFloat(rootAttrs.height);
  if (!(width > 0 && height > 0)) throw new Error('Tracer SVG has no size');

  const shapes: Shape[] = [];
  for (const m of svg.matchAll(/<path\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1]);
    if (!a.d) continue;
    let dx = 0, dy = 0;
    const tr = a.transform?.match(/translate\(\s*([-\d.eE+]+)[\s,]+([-\d.eE+]+)\s*\)/);
    if (tr) {
      dx = parseFloat(tr[1]);
      dy = parseFloat(tr[2]);
    }
    const segs = parsePathData(a.d, dx, dy);
    if (segs.length) shapes.push({ fill: normalizeColor(a.fill ?? '#000000'), segs });
  }
  return { width, height, shapes };
}

export function normalizeColor(value: string): string {
  const v = value.trim().toLowerCase();
  const short = v.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  const rgb = v.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
  if (rgb) return rgbToHex(+rgb[1], +rgb[2], +rgb[3]);
  return '#000000';
}

const TOKEN_RE = /[MmLlHhVvCcSsQqZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

/** Parses path data into absolute M/L/C/Z segments, offset by (dx, dy). */
export function parsePathData(d: string, dx = 0, dy = 0): Seg[] {
  const tokens = d.match(TOKEN_RE) ?? [];
  const segs: Seg[] = [];
  let i = 0;
  let cmd = '';
  let x = 0, y = 0, sx = 0, sy = 0;
  let lastCtrl: [number, number] | null = null;
  const num = () => {
    const v = parseFloat(tokens[i++]);
    if (Number.isNaN(v)) throw new Error('Malformed path data');
    return v;
  };
  const hasNumber = () => i < tokens.length && !/^[A-Za-z]$/.test(tokens[i]);

  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) cmd = tokens[i++];
    else if (!cmd) throw new Error('Path data must start with a command');
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case 'M': {
        x = ox + num(); y = oy + num();
        sx = x; sy = y;
        segs.push({ t: 'M', x: x + dx, y: y + dy });
        cmd = rel ? 'l' : 'L'; // extra pairs after a moveto are linetos
        lastCtrl = null;
        break;
      }
      case 'L': x = ox + num(); y = oy + num(); segs.push({ t: 'L', x: x + dx, y: y + dy }); lastCtrl = null; break;
      case 'H': x = ox + num(); segs.push({ t: 'L', x: x + dx, y: y + dy }); lastCtrl = null; break;
      case 'V': y = oy + num(); segs.push({ t: 'L', x: x + dx, y: y + dy }); lastCtrl = null; break;
      case 'C': {
        const x1 = ox + num(), y1 = oy + num(), x2 = ox + num(), y2 = oy + num();
        x = ox + num(); y = oy + num();
        segs.push({ t: 'C', x1: x1 + dx, y1: y1 + dy, x2: x2 + dx, y2: y2 + dy, x: x + dx, y: y + dy });
        lastCtrl = [x2, y2];
        break;
      }
      case 'S': {
        const x1 = lastCtrl ? 2 * x - lastCtrl[0] : x, y1 = lastCtrl ? 2 * y - lastCtrl[1] : y;
        const x2 = ox + num(), y2 = oy + num();
        x = ox + num(); y = oy + num();
        segs.push({ t: 'C', x1: x1 + dx, y1: y1 + dy, x2: x2 + dx, y2: y2 + dy, x: x + dx, y: y + dy });
        lastCtrl = [x2, y2];
        break;
      }
      case 'Q': {
        const qx = ox + num(), qy = oy + num();
        const nx = ox + num(), ny = oy + num();
        segs.push({
          t: 'C',
          x1: x + (2 / 3) * (qx - x) + dx, y1: y + (2 / 3) * (qy - y) + dy,
          x2: nx + (2 / 3) * (qx - nx) + dx, y2: ny + (2 / 3) * (qy - ny) + dy,
          x: nx + dx, y: ny + dy,
        });
        x = nx; y = ny;
        lastCtrl = null;
        break;
      }
      case 'Z': {
        segs.push({ t: 'Z' });
        x = sx; y = sy;
        lastCtrl = null;
        break;
      }
      default:
        throw new Error(`Unsupported path command ${cmd}`);
    }
    if (cmd.toUpperCase() === 'Z' && hasNumber()) throw new Error('Malformed path data');
  }
  return segs;
}

// ---------------------------------------------------------------------------
// Inspection

export interface PaletteEntry {
  color: string;
  shapes: number;
  /** Approximate covered area in traced pixels (endpoint polygon). */
  area: number;
}

export function palette(doc: VectorDoc): PaletteEntry[] {
  const byColor = new Map<string, PaletteEntry>();
  for (const shape of doc.shapes) {
    const entry = byColor.get(shape.fill) ?? { color: shape.fill, shapes: 0, area: 0 };
    entry.shapes++;
    entry.area += Math.abs(signedArea(shape.segs));
    byColor.set(shape.fill, entry);
  }
  return [...byColor.values()].sort((a, b) => b.area - a.area);
}

function signedArea(segs: Seg[]): number {
  let area = 0;
  let px = 0, py = 0, sx = 0, sy = 0;
  for (const s of segs) {
    if (s.t === 'M') { px = sx = s.x; py = sy = s.y; continue; }
    const nx = s.t === 'Z' ? sx : s.x;
    const ny = s.t === 'Z' ? sy : s.y;
    area += px * ny - nx * py;
    px = nx; py = ny;
  }
  return area / 2;
}

export function countNodes(doc: VectorDoc): number {
  let n = 0;
  for (const shape of doc.shapes) for (const s of shape.segs) if (s.t !== 'Z') n++;
  return n;
}

// ---------------------------------------------------------------------------
// Writers

export function fmt(n: number, precision: number): string {
  const s = n.toFixed(precision);
  const trimmed = precision > 0 ? s.replace(/\.?0+$/, '') : s;
  return trimmed === '-0' ? '0' : trimmed;
}

export function pathData(segs: Seg[], precision = 2): string {
  const f = (n: number) => fmt(n, precision);
  const out: string[] = [];
  for (const s of segs) {
    switch (s.t) {
      case 'M': out.push(`M${f(s.x)} ${f(s.y)}`); break;
      case 'L': out.push(`L${f(s.x)} ${f(s.y)}`); break;
      case 'C': out.push(`C${f(s.x1)} ${f(s.y1)} ${f(s.x2)} ${f(s.y2)} ${f(s.x)} ${f(s.y)}`); break;
      case 'Z': out.push('Z'); break;
    }
  }
  return out.join('');
}

export function toSvg(doc: VectorDoc, size: OutputSize, precision = 2): string {
  const paths = doc.shapes.map((s) => `<path fill="${s.fill}" d="${pathData(s.segs, precision)}"/>`);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${fmt(size.width, 2)}" height="${fmt(size.height, 2)}" viewBox="0 0 ${doc.width} ${doc.height}">`,
    ...paths,
    '</svg>',
    '',
  ].join('\n');
}

function rgb01(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** PostScript and PDF share the same path operators (m, l, c, h). */
function pdfPathOps(segs: Seg[]): string {
  const f = (n: number) => fmt(n, 3);
  const out: string[] = [];
  for (const s of segs) {
    switch (s.t) {
      case 'M': out.push(`${f(s.x)} ${f(s.y)} m`); break;
      case 'L': out.push(`${f(s.x)} ${f(s.y)} l`); break;
      case 'C': out.push(`${f(s.x1)} ${f(s.y1)} ${f(s.x2)} ${f(s.y2)} ${f(s.x)} ${f(s.y)} c`); break;
      case 'Z': out.push('h'); break;
    }
  }
  return out.join('\n');
}

function colorOp(hex: string, op: string): string {
  return `${rgb01(hex).map((c) => fmt(c, 4)).join(' ')} ${op}`;
}

export function toEps(doc: VectorDoc, size: OutputSize, title = 'vector'): string {
  const sx = size.width / doc.width;
  const sy = size.height / doc.height;
  const body = doc.shapes.map((s) => `${colorOp(s.fill, 'rg')}\nn\n${pdfPathOps(s.segs)}\nf`);
  return [
    '%!PS-Adobe-3.0 EPSF-3.0',
    '%%Creator: Pathwise',
    `%%Title: ${title.replace(/[\r\n]/g, ' ')}`,
    `%%BoundingBox: 0 0 ${Math.ceil(size.width)} ${Math.ceil(size.height)}`,
    `%%HiResBoundingBox: 0 0 ${fmt(size.width, 3)} ${fmt(size.height, 3)}`,
    '%%LanguageLevel: 2',
    '%%Pages: 1',
    '%%EndComments',
    '%%BeginProlog',
    '/m {moveto} bind def /l {lineto} bind def /c {curveto} bind def',
    '/h {closepath} bind def /n {newpath} bind def /f {fill} bind def',
    '/rg {setrgbcolor} bind def',
    '%%EndProlog',
    '%%Page: 1 1',
    'gsave',
    `0 ${fmt(size.height, 3)} translate ${fmt(sx, 6)} ${fmt(-sy, 6)} scale`,
    ...body,
    'grestore',
    'showpage',
    '%%EOF',
    '',
  ].join('\n');
}

async function deflate(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function toPdf(doc: VectorDoc, size: OutputSize, compress = true): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const sx = size.width / doc.width;
  const sy = size.height / doc.height;
  const content = [
    'q',
    `${fmt(sx, 6)} 0 0 ${fmt(-sy, 6)} 0 ${fmt(size.height, 3)} cm`,
    ...doc.shapes.map((s) => `${colorOp(s.fill, 'rg')}\n${pdfPathOps(s.segs)}\nf`),
    'Q',
  ].join('\n');
  const raw = enc.encode(content);
  const packed = compress ? await deflate(raw) : null;
  const stream = packed ?? raw;

  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let offset = 0;
  const push = (chunk: string | Uint8Array) => {
    const bytes = typeof chunk === 'string' ? enc.encode(chunk) : chunk;
    parts.push(bytes);
    offset += bytes.length;
  };
  const obj = (n: number, body: string) => {
    offsets[n] = offset;
    push(`${n} 0 obj\n${body}\nendobj\n`);
  };

  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // binary marker comment
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(size.width, 3)} ${fmt(size.height, 3)}] /Resources << >> /Contents 4 0 R >>`);
  offsets[4] = offset;
  push(`4 0 obj\n<< /Length ${stream.length}${packed ? ' /Filter /FlateDecode' : ''} >>\nstream\n`);
  push(stream);
  push('\nendstream\nendobj\n');
  obj(5, '<< /Producer (Pathwise) >>');

  const xref = offset;
  const entries = offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  push(`xref\n0 ${offsets.length}\n0000000000 65535 f \n${entries}`);
  push(`trailer\n<< /Size ${offsets.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(offset);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// DXF (AutoCAD R12): curves are flattened into closed polylines, one layer per colour.

/** Splits shape segments into flattened point rings, one per subpath. */
export function flatten(segs: Seg[], tolerance = 0.5): Array<Array<[number, number]>> {
  const rings: Array<Array<[number, number]>> = [];
  let ring: Array<[number, number]> = [];
  let x = 0, y = 0;
  const close = () => {
    if (ring.length >= 2) rings.push(ring);
    ring = [];
  };
  for (const s of segs) {
    if (s.t === 'M') {
      close();
      x = s.x; y = s.y;
      ring.push([x, y]);
    } else if (s.t === 'L') {
      x = s.x; y = s.y;
      ring.push([x, y]);
    } else if (s.t === 'C') {
      const hull = Math.hypot(s.x1 - x, s.y1 - y) + Math.hypot(s.x2 - s.x1, s.y2 - s.y1) + Math.hypot(s.x - s.x2, s.y - s.y2);
      const steps = Math.min(64, Math.max(2, Math.ceil(Math.sqrt(hull / tolerance))));
      for (let k = 1; k <= steps; k++) {
        const t = k / steps, u = 1 - t;
        ring.push([
          u * u * u * x + 3 * u * u * t * s.x1 + 3 * u * t * t * s.x2 + t * t * t * s.x,
          u * u * u * y + 3 * u * u * t * s.y1 + 3 * u * t * t * s.y2 + t * t * t * s.y,
        ]);
      }
      x = s.x; y = s.y;
    } else {
      close();
    }
  }
  close();
  return rings;
}

let aciTable: Array<[number, number, number]> | null = null;

/** AutoCAD Colour Index palette: 1–9 named colours, 10–249 hue wheel, 250–255 grays. */
function aci(): Array<[number, number, number]> {
  if (aciTable) return aciTable;
  const table: Array<[number, number, number]> = [];
  const named: Array<[number, number, number]> = [
    [255, 0, 0], [255, 255, 0], [0, 255, 0], [0, 255, 255], [0, 0, 255], [255, 0, 255], [255, 255, 255], [128, 128, 128], [192, 192, 192],
  ];
  named.forEach((c, i) => (table[i + 1] = c));
  const levels = [255, 165, 127, 76, 38].map((v) => v / 255);
  for (let hue = 0; hue < 24; hue++) {
    levels.forEach((v, li) => {
      table[10 + hue * 10 + li * 2] = hsv(hue * 15, 1, v);
      table[11 + hue * 10 + li * 2] = hsv(hue * 15, 0.5, v);
    });
  }
  [51, 80, 105, 130, 190, 255].forEach((g, i) => (table[250 + i] = [g, g, g]));
  aciTable = table;
  return table;
}

const GRAY_ACI = [8, 9, 250, 251, 252, 253, 254, 255];

function hsv(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
}

export function nearestAci(hex: string): number {
  const [r, g, b] = rgb01(hex).map((c) => c * 255);
  const table = aci();
  // Neutral colours stay on the gray entries rather than drifting to a dark hue.
  // Index 7 is skipped: it flips between black and white with the background.
  const neutral = Math.max(r, g, b) - Math.min(r, g, b) < 24;
  const candidates = neutral ? GRAY_ACI : table.flatMap((c, i) => (c && i !== 7 ? [i] : []));
  let best = candidates[0], bestDist = Infinity;
  for (const i of candidates) {
    const c = table[i];
    const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

export function toDxf(doc: VectorDoc, size: OutputSize): string {
  const sx = size.width / doc.width;
  const sy = size.height / doc.height;
  const out: string[] = [];
  const g = (code: number, value: string | number) => out.push(String(code), String(value));
  const num = (n: number) => fmt(n, 4);

  const layers = new Map<string, string>();
  for (const s of doc.shapes) layers.set(s.fill, `COLOR_${s.fill.slice(1).toUpperCase()}`);

  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$EXTMIN'); g(10, 0); g(20, 0);
  g(9, '$EXTMAX'); g(10, num(size.width)); g(20, num(size.height));
  g(0, 'ENDSEC');

  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 1);
  g(0, 'LTYPE'); g(2, 'CONTINUOUS'); g(70, 0); g(3, 'Solid line'); g(72, 65); g(73, 0); g(40, '0.0');
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, layers.size);
  for (const [color, name] of layers) {
    g(0, 'LAYER'); g(2, name); g(70, 0); g(62, nearestAci(color)); g(6, 'CONTINUOUS');
  }
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');

  g(0, 'SECTION'); g(2, 'ENTITIES');
  for (const shape of doc.shapes) {
    const layer = layers.get(shape.fill)!;
    for (const ring of flatten(shape.segs)) {
      g(0, 'POLYLINE'); g(8, layer); g(66, 1); g(10, 0); g(20, 0); g(30, 0); g(70, 1);
      for (const [x, y] of ring) {
        g(0, 'VERTEX'); g(8, layer); g(10, num(x * sx)); g(20, num(size.height - y * sy)); g(30, 0);
      }
      g(0, 'SEQEND'); g(8, layer);
    }
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return out.join('\n') + '\n';
}

export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
