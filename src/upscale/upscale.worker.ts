// Runs the Real-ESRGAN upscaler on the GPU off the main thread.
import { EsrganUpscaler } from './esrgan.ts';

export interface UpscaleRequest {
  id: number;
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
  modelBase: string;
}

export type UpscaleMessage =
  | { id: number; type: 'progress'; done: number; total: number }
  | { id: number; type: 'done'; pixels: Uint8ClampedArray; width: number; height: number; ms: number }
  | { id: number; type: 'error'; error: string };

let upscaler: Promise<EsrganUpscaler> | null = null;

self.onmessage = async (event: MessageEvent<UpscaleRequest>) => {
  const { id, pixels, width, height, modelBase } = event.data;
  const post = (msg: UpscaleMessage, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);
  try {
    upscaler ??= EsrganUpscaler.create(modelBase);
    const model = await upscaler;
    const start = performance.now();
    const out = await model.upscale(pixels, width, height, (p) => post({ id, type: 'progress', ...p }));
    post({ id, type: 'done', pixels: out, width: width * 4, height: height * 4, ms: performance.now() - start }, [out.buffer]);
  } catch (err) {
    upscaler = null;
    post({ id, type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
};
