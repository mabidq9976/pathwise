// Trace settings, presets, and the automatic preset picker.

export type Engine = 'precision' | 'classic';
export type ColorMode = 'color' | 'binary';
export type CurveMode = 'spline' | 'polygon' | 'pixel';
export type Stacking = 'stacked' | 'cutout';
export type OutlineStyle = 'detailed' | 'balanced' | 'minimal';
export type EnhanceMode = 'off' | 'x2' | 'x4';

export interface TraceSettings {
  /** precision: sub-pixel edges + shape fitting (flat art); classic: vtracer (photos, pixel art). */
  engine: Engine;
  colorMode: ColorMode;
  mode: CurveMode;
  hierarchical: Stacking;
  /** Bits kept per channel when clustering colours (1–8). */
  colorPrecision: number;
  /** Minimum colour difference between stacked layers (0–128). */
  layerDifference: number;
  /** Patches smaller than this many pixels are dropped. */
  filterSpeckle: number;
  /** Turns sharper than this (degrees) are kept as corners. */
  cornerThreshold: number;
  /** Minimum spline segment length. */
  lengthThreshold: number;
  /** Angle (degrees) at which a curve is split into separate splines. */
  spliceThreshold: number;
  maxIterations: number;
  /** Decimal places written for each coordinate. */
  pathPrecision: number;
  /** Longest side the bitmap is downsampled to before tracing. */
  maxDimension: number;
  /** Precision engine palette limit; 0 = automatic. */
  maxColors: number;
  /** Precision engine detail level, layered on top of the preset. */
  outline: OutlineStyle;
  /** Local AI upscale (Real-ESRGAN on the GPU) before tracing. */
  enhance: EnhanceMode;
}

export type PresetId = 'photo' | 'poster' | 'logo' | 'bw' | 'pixel';

const BASE: TraceSettings = {
  engine: 'classic',
  colorMode: 'color',
  mode: 'spline',
  hierarchical: 'stacked',
  colorPrecision: 6,
  layerDifference: 16,
  filterSpeckle: 4,
  cornerThreshold: 60,
  lengthThreshold: 4,
  spliceThreshold: 45,
  maxIterations: 10,
  pathPrecision: 2,
  maxDimension: 1600,
  maxColors: 0,
  outline: 'balanced',
  enhance: 'off',
};

const PRECISION: TraceSettings = {
  ...BASE,
  engine: 'precision',
  colorPrecision: 7,
  filterSpeckle: 2,
  cornerThreshold: 30,
  lengthThreshold: 4,
  pathPrecision: 3,
};

export const PRESETS: Record<PresetId, { label: string; settings: TraceSettings }> = {
  photo: {
    label: 'Photo',
    settings: { ...BASE, filterSpeckle: 10, colorPrecision: 8, layerDifference: 48, cornerThreshold: 180 },
  },
  poster: {
    label: 'Poster',
    // Precision handles thin details (birds, hairlines) far better than Classic
    // here: 99.0% vs 95.2% match on the sunset example.
    settings: { ...PRECISION },
  },
  logo: {
    label: 'Logo',
    settings: { ...PRECISION },
  },
  bw: {
    label: 'Black & white',
    settings: { ...PRECISION, colorMode: 'binary', lengthThreshold: 6 },
  },
  pixel: {
    label: 'Pixel art',
    settings: { ...BASE, mode: 'pixel', filterSpeckle: 0, colorPrecision: 8, layerDifference: 0, pathPrecision: 0, maxDimension: 512 },
  },
};

/**
 * Outline styles layer on top of a preset. Balanced keeps the preset as tuned;
 * Detailed and Minimal override the detail-related settings and the engine's
 * internal fairing parameters.
 */
export const OUTLINE_STYLES: Record<
  OutlineStyle,
  { label: string; hint: string; values: Partial<TraceSettings>; engine: { fairing: number; fairTolerance: number; snapAngle: number; localContrast: number; symmetry: number } }
> = {
  detailed: {
    label: 'Detailed',
    hint: 'Keeps tiny shapes and every distinct colour; 0.12 px fit; traces large images at up to 4096 px.',
    values: { colorPrecision: 8, filterSpeckle: 1, lengthThreshold: 2.5, maxDimension: 4096 },
    engine: { fairing: 3, fairTolerance: 0.3, snapAngle: 0.75, localContrast: 3, symmetry: 0.35 },
  },
  balanced: {
    label: 'Balanced',
    hint: 'The preset as tuned: faithful edges with clean curves.',
    values: {},
    engine: { fairing: 6, fairTolerance: 0.5, snapAngle: 1.5, localContrast: 3, symmetry: 0.5 },
  },
  minimal: {
    label: 'Minimal',
    hint: 'Fewest nodes: drops specks, smooths harder and snaps near-straight angles. Use Max colours to also reduce the palette.',
    values: { filterSpeckle: 4, lengthThreshold: 9, maxDimension: 1600 },
    engine: { fairing: 10, fairTolerance: 0.8, snapAngle: 3, localContrast: 0, symmetry: 0.8 },
  },
};

/** A preset's settings with an outline style applied (precision presets only). */
export function withOutline(settings: TraceSettings, outline: OutlineStyle): TraceSettings {
  if (settings.engine !== 'precision') return { ...settings, outline };
  return { ...settings, ...OUTLINE_STYLES[outline].values, outline };
}

/**
 * Options for the precision engine (src/precision/engine.ts). `scale` is trace
 * pixels per original pixel when the image was AI-enhanced: tolerances and speck
 * sizes are scaled so detail decisions stay in original-pixel terms.
 */
export function toPrecisionOptions(s: TraceSettings, scale = 1) {
  const { symmetry, ...style } = OUTLINE_STYLES[s.outline].engine;
  return {
    stacking: s.hierarchical,
    binary: s.colorMode === 'binary',
    // Colour detail 1–8 → Oklab merge distance 0.2 … ~0.017.
    colorTolerance: 0.2 * 0.7 ** (Math.min(8, Math.max(1, s.colorPrecision)) - 1),
    maxColors: s.maxColors,
    minArea: Math.max(0.5, (s.filterSpeckle * s.filterSpeckle) / 2) * scale * scale,
    cornerAngle: s.cornerThreshold,
    // Smoothness 2–10 → max curve deviation 0.1–0.5 px.
    fitTolerance: s.lengthThreshold * 0.05 * scale,
    optimal: true,
    ...style,
    fairTolerance: style.fairTolerance * scale,
    // Asymmetry (original px) a human would read as noise on a symmetric
    // feature at least 4 px long: a dome, an arch, a star point.
    symmetry: { tolerance: symmetry * scale, minSpan: 4 * scale },
    scale,
    // Upscaling gives even 1 px lines a solid core, so their colours are learnt
    // normally; what stays unexplained after upscaling is magnified noise.
    recoverLines: scale < 1.5,
  };
}

const RADIANS = Math.PI / 180;

/**
 * The config object the vtracer WASM build expects. It takes vtracer's internal
 * converter units rather than the CLI's: angles in radians, colour precision as
 * bits *lost* (8 crashes it), and speckle size as an area.
 */
export function toTracerConfig(s: TraceSettings) {
  return {
    binary: s.colorMode === 'binary',
    mode: s.mode,
    hierarchical: s.hierarchical,
    cornerThreshold: s.cornerThreshold * RADIANS,
    lengthThreshold: Math.max(3.5, s.lengthThreshold),
    maxIterations: s.maxIterations,
    spliceThreshold: s.spliceThreshold * RADIANS,
    filterSpeckle: s.filterSpeckle * s.filterSpeckle,
    colorPrecision: 8 - Math.min(8, Math.max(1, s.colorPrecision)),
    layerDifference: s.layerDifference,
    pathPrecision: s.pathPrecision,
  };
}

export interface ImageProfile {
  preset: PresetId;
  significantColors: number;
  grayscale: boolean;
  reason: string;
}

/**
 * Picks a preset from a sample of the image's pixels: how many distinct colours
 * carry real weight, whether it is grayscale, and whether it is tiny.
 */
export function profileImage(data: Uint8ClampedArray, width: number, height: number): ImageProfile {
  const total = width * height;
  const step = Math.max(1, Math.floor(total / 40000));
  const buckets = new Map<number, number>();
  const exact = new Set<number>();
  let samples = 0;
  let gray = 0;
  let extremes = 0;

  for (let p = 0; p < total; p += step) {
    const i = p * 4;
    if (data[i + 3] < 128) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    samples++;
    if (Math.max(r, g, b) - Math.min(r, g, b) < 14) gray++;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (lum < 70 || lum > 190) extremes++;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
    if (exact.size <= 64) exact.add((r << 16) | (g << 8) | b);
  }

  if (samples === 0) {
    return { preset: 'logo', significantColors: 0, grayscale: false, reason: 'Image is fully transparent' };
  }

  const floor = samples * 0.002;
  let significantColors = 0;
  for (const count of buckets.values()) if (count >= floor) significantColors++;
  const grayscale = gray / samples > 0.98;

  if (grayscale && extremes / samples > 0.9) {
    return { preset: 'bw', significantColors, grayscale, reason: 'Mostly black and white' };
  }
  // Pixel art has hard edges: a handful of exact colours and no anti-aliased blends.
  if (total <= 512 * 512 && exact.size <= 64) {
    return { preset: 'pixel', significantColors, grayscale, reason: `${exact.size} exact colours with hard pixel edges` };
  }
  if (significantColors <= 24) {
    return { preset: 'logo', significantColors, grayscale, reason: `About ${significantColors} flat colours` };
  }
  if (significantColors <= 90) {
    return { preset: 'poster', significantColors, grayscale, reason: 'Moderate palette with some shading' };
  }
  return { preset: 'photo', significantColors, grayscale, reason: 'Rich colour and gradients' };
}
