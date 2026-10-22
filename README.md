# Pathwise

An computer vision image-to-vector webapp. It traces PNG, JPG, WebP, GIF and BMP bitmaps into
SVG, PDF, EPS, DXF or high-resolution PNG. Tracing runs locally in the browser
(in a Web Worker), so images are never uploaded.

```bash
npm install
npm run dev       # http://localhost:5173
npm test          # engine, parser and exporter tests (Node 22.6+)
npm run build     # type-check + static build in dist/
```

## Features

- Choose, drag-and-drop or paste (⌘V / Ctrl V) an image (PNG, JPG, WebP, AVIF, GIF, BMP), or try a built-in example.
- **Two engines**:
  - **Precision** (default for logos, text, icons and line art): sub-pixel edges,
    reconstructed corners, and exact lines, circles and ellipses.
  - **Classic** (default for photos, gradients and pixel art): vtracer's
    hierarchical colour clustering.
- **Auto preset**: samples the image and picks Photo, Poster, Logo, Black & white
  or Pixel art, together with the right engine. Every setting can still be
  adjusted, and the result re-traces live.
- **Outline style** (Precision engine), layered on top of the preset:
  - **Detailed:** keeps tiny shapes and every distinct colour, 0.12 px fit, traces at up to 4096 px.
  - **Balanced:** the preset as tuned.
  - **Minimal:** fewest nodes; drops specks, smooths harder, snaps near-straight angles.
- **Enhance (AI, local):** Off / 2× / 4× Real-ESRGAN upscale on your GPU before
  tracing, for small, soft or compressed images. Nothing is uploaded.
- **Match score:** every trace is rendered back and compared with the source along
  edges. With Enhance on, it is scored against your original image.
- Output controls: full colour or black and white, and stacked or cutout shapes.
  Fine-tuning controls cover max colours, colour detail, speck removal, corner
  angle, smoothness, coordinate decimals and trace resolution.
- Viewer with Original / Compare (split slider) / Vector / Outlines modes,
  wheel or pinch zoom, drag to pan, and keys 1–4 and F.
- Palette of the colours used; click one to highlight its shapes.
- Exports: SVG, PDF and EPS (native Bézier paths), DXF (R12 polylines, one layer
  per colour), and PNG at 1×, 2× or 4×. The writers are in `src/vector.ts` and
  need no third-party libraries.

## Precision engine (`src/precision/`)

The stage order follows vectorizer.ai's pipeline as seen in its public client
and API docs: palette, regions, corners and symmetry, then a geometry model.
Every stage is implemented here from scratch.

1. **Palette** (`palette.ts`): colours are clustered in Oklab from interior
   ("stable") pixels only, so anti-aliased blends never become colours.
2. **Anti-alias unmixing** (`palette.ts`): each edge pixel is explained as a
   blend of two palette colours with a coverage fraction. A blend may only use
   colours that appear as solid pixels nearby, and a pixel only counts as solid
   when its neighbours agree. Thin features with no solid core are paired with
   their background against every palette colour. Colours that occur only in
   thin lines are recovered from those lines' cores.
   In black & white mode, local-contrast recovery finds faint hairlines and gaps
   that a global threshold would lose. Their width is still measured on the
   unboosted coverage, so faint hatching stays thin.
3. **Sub-pixel regions** (`contours.ts`): marching squares at 50% coverage,
   refined by partial-area-effect edge location (coverage summed across the
   edge gives its exact position). Edges land within ~0.001 px on clean renders.
   Strokes thinner than the window use a thin-stroke model: summed coverage gives
   the width, the centroid gives the centre.
4. **Symmetry** (`symmetry.ts`): designed shapes such as domes, arches,
   windows, finials, stars and crosses are mirror-symmetric, but pixels push one
   side a little in and the other out. Stretches of a contour that mirror each
   other within the style's tolerance are found and made exact. They are seeded
   at the tops and sides of bumps and at sharp tips, and grown outwards with
   sub-pixel partners. The axis is the least-squares mirror line, refined by
   re-pairing (ICP). Only upright axes count, or a mirror covering a whole
   closed shape at any angle; local mirrors at odd angles are coincidence.
   Straight edges and lone corners are ignored, since any two straight arms
   mirror each other. The fitter then makes paired corners exact mirror images.
   It fits each symmetric piece only up to its axis and mirrors the rest, so
   both halves come out identical.
5. **Corners** (`fit.ts`): a corner is confirmed by the straightness of its
   arms, plus a model selection between "two lines meeting" and "one arc".
   Its tip is rebuilt by extending the arms past the blur, which reaches
   further for sharper angles. A ~180° turn is classified as either a stroke's
   end cap (sides parallel, so traced round) or a tapered tip (sides converge,
   so the point is rebuilt where they meet).
6. **Geometry** (`fit.ts`):
   - exact lines for straight runs, trimmed back to the true tangent point so
     bowls (a U's counter) stay round. A run whose offsets follow a parabola
     rising more than 0.25% of its length (a leaf's side, which hugs a line for
     a while) is drawn as part of the curve instead, at half the fit tolerance.
     Stems, walls and rounded-rectangle sides don't bend and keep exact lines;
   - circles and ellipses from area moments; any closed outline within ~1% of an
     ellipse becomes an exact one, even if noise produced a stray corner;
   - fewest-node optimal fitting (dynamic programming over breakpoints) instead
     of greedy splitting;
   - straight runs snap to exact 0/45/90° within the style's snap angle;
   - curved strokes drawn as chains of gently-angled straight facets (as browsers
     flatten curves) are refit as one smooth curve;
   - circular arcs, then least-squares Béziers (Schneider), tangent-locked to
     adjoining lines so joins are smooth;
   - Taubin fairing first removes rasteriser ripple, such as the facets a
     browser leaves on curved strokes, without shrinking curves;
   - node reduction merges neighbouring curves that one curve can replace;
   - ~180° turns between parallel sides are treated as stroke end caps, not
     corners;
   - tolerances adapt to each contour's measured noise level;
   - on enhanced images, shape-size judgements scale with the enhance factor.
     These are the shortest straight line and the length of a corner's arms,
     so a few pixels of a small dome don't pass for a straight edge.
     Blur-size judgements stay in image pixels.
   - Black & white mode solves ink coverage from gamma-space luma, which is
     linear in the blend fraction, unlike perceptual lightness.
7. **Stacking** (`engine.ts`): layers are cumulative-coverage regions, so shared
   boundaries never leave gaps.

On the built-in badge (640 px), Precision gives 5 exact colours, 170 nodes and
a 6.1 KB SVG, with edge error 2.4 against 13.0 for Classic. The star comes out
as 10 straight lines with every point within 0.32 px. The ink leaf traces in
176 nodes with smooth strokes and round caps.

## AI enhance (`src/upscale/`)

[Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) "animevideov3"
(SRVGGNetCompact, ×4, tuned for line art). It uses the official v0.2.5.0 weights
(BSD-3-Clause, see `public/models/LICENSE-Real-ESRGAN.txt`), converted to raw
float32 by a stdlib-only reader that cannot execute code from the file.

- Inference is our own WebGPU compute shaders (`esrgan.ts`), run in a worker. The
  image is processed in 160 px tiles with 20 px overlap (more than the network's
  18 px reach), so tiles join exactly. The output matches a CPU reference to
  within 1/255.
- 740 px → 2960 px takes about 1.7 s on an Apple-silicon GPU. 2× is the 4×
  result downscaled with high quality.
- Tracing an enhanced image scales the tolerances and speck size by the enhance
  factor, so detail decisions stay in original-pixel terms. Thin-line colour
  recovery is skipped there; minor colours are pruned when they are blends or
  near-duplicates of major ones.

Ground truth (`/qa.html`, crisp art shrunk to ¼ and saved as JPEG q=0.55, then
traced and scored against the crisp original):

| input | off | 2× | 4× |
| --- | --- | --- | --- |
| badge 160 px JPEG | 80.1% | **91.4%** | 90.1% |
| ink leaf 160 px JPEG | 57.7% | **87.7%** | 87.9% |
| parrot 740 px AVIF (vs original) | 91.4% | 92.9% | 93.4% |

2× is the sweet spot; 4× costs more time for little gain.

## Classic engine notes

The Classic tracer is [vtracer](https://github.com/visioncortex/vtracer) (MIT),
used through the `vtracer-wasm` package (MIT). That build reads vtracer's
internal converter units rather than its CLI units, so `toTracerConfig`
converts them:

- angles are passed in radians;
- colour precision is passed as bits *lost* (`8 − precision`); a raw 8 crashes it;
- speck size is passed as an area (`size²`).

## Desktop app (Mac `.dmg`, Windows `.exe`)

`electron/main.cjs` wraps the built app in Electron. It serves `dist/` from a
private `app://pathwise/` origin, so WebGPU (the AI Enhance), workers and
fetch behave exactly as in Chrome. Nothing is uploaded; the only network
request is the update check.

```bash
npm run desktop     # build and open the desktop app
npm run dist        # build installers into release/ (current OS)
```

**Updates.** Installed copies check GitHub Releases
(`mabidq9976/pathwise`, set under `build.publish` in `package.json`) at launch.
They download a newer version in the background and offer to restart. To ship
an update:

```bash
npm version patch          # bumps the version and creates a tag
git push --follow-tags     # .github/workflows/release.yml builds and publishes
```

The workflow builds the `.dmg` (Apple Silicon and Intel) on macOS and the
`.exe` setup on Windows, then attaches them to a GitHub Release.

**Signing.** Unsigned builds work, but each system warns on first launch: on
Mac, right-click → Open; on Windows, "More info → Run anyway". Mac automatic
updates also require a signed app. Add the secrets listed at the top of the
workflow (an Apple Developer ID, a Windows code-signing certificate) and builds
are signed automatically.

## Layout

| File | Role |
| --- | --- |
| `src/main.ts` | App state, UI wiring, loading, export |
| `src/viewer.ts` | Zoom/pan/compare viewer |
| `src/trace.worker.ts`, `src/tracer.ts` | Both engines in a worker; new requests cancel stale ones |
| `src/precision/*` | Precision engine |
| `src/settings.ts` | Settings, presets, auto-detection, engine option mapping |
| `src/vector.ts` | Vector model, SVG parsing, SVG/EPS/PDF/DXF writers |
| `src/examples.ts` | Example images drawn at runtime (no bundled assets) |
| `src/upscale/*` | Real-ESRGAN on WebGPU (`esrgan.ts`), its worker and client |
| `public/models/` | Real-ESRGAN weights (float32) + manifest + licence |
| `src/quality.ts` | Fidelity score: render back and compare along edges |
| `qa.html`, `src/qa.ts` | Dev-only QA bench (`/qa.html`): every test image × every style, with metrics and source-vs-vector crops; picks up `samples/parrot.avif` if present |
| `tests/` | Geometry tests using exact, Chrome-like coarse, and blurred and noisy renders |

## Background

The feature set and pipeline stages were modelled on vectorizer.ai, which was
inspected with [REA](https://github.com/morluto/rea). The REA inspection covered:

- its UI labels, editor view modes and export formats;
- the preview stages its client decodes (palette, region, corner, symmetry,
  geometry);
- its public OpenAPI parameters (corner reconstruction, parameterised shapes,
  curve types, gap filler).

No code, assets or models from that site are used. Its vectorization engine and
trained models run on its servers and are not part of the page.
