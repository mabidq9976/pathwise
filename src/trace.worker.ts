// Runs tracing off the main thread: the vtracer WASM build ("classic") or the
// precision engine, then scores the result against the source pixels.
import init, { to_svg } from 'vtracer-wasm';
import wasmUrl from 'vtracer-wasm/vtracer.wasm?url';
import { precisionTrace, type PrecisionOptions } from './precision/engine.ts';
import { measureFidelity, type Fidelity } from './quality.ts';
import { parseTracerSvg, type VectorDoc } from './vector.ts';

export type TraceRequest = {
  id: number;
  pixels: Uint8Array;
  width: number;
  height: number;
} & ({ engine: 'classic'; config: Record<string, unknown> } | { engine: 'precision'; options: PrecisionOptions });

export type TraceResponse =
  | { id: number; ok: true; doc: VectorDoc; ms: number; fidelity: Fidelity | null }
  | { id: number; ok: false; error: string };

let ready: Promise<unknown> | null = null;

self.onmessage = async (event: MessageEvent<TraceRequest>) => {
  const req = event.data;
  let reply: TraceResponse;
  try {
    const start = performance.now();
    let doc: VectorDoc;
    if (req.engine === 'precision') {
      doc = precisionTrace(req.pixels, req.width, req.height, req.options);
    } else {
      await (ready ??= init({ module_or_path: wasmUrl }));
      doc = parseTracerSvg(to_svg(req.pixels, req.width, req.height, req.config));
    }
    const ms = performance.now() - start;
    reply = { id: req.id, ok: true, doc, ms, fidelity: measureFidelity(doc, req.pixels, req.width, req.height) };
  } catch (err) {
    reply = { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(reply);
};
