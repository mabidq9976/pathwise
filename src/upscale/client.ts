// Main-thread client for the upscaler worker: ×4 Real-ESRGAN, then optionally a
// high-quality downscale to ×2. Alpha is carried over from a smooth upscale of the
// original, since the network only sees colour.
import type { UpscaleMessage, UpscaleRequest } from './upscale.worker.ts';

export type EnhanceFactor = 2 | 4;

const MODEL_BASE = `${import.meta.env.BASE_URL}models/realesr-animevideov3`;

export class Enhancer {
  private worker: Worker | null = null;
  private nextId = 1;
  private cache = new WeakMap<ImageBitmap, Promise<HTMLCanvasElement>>();

  /** Returns a canvas `factor`× the bitmap's size. Results are cached per bitmap. */
  async enhance(bitmap: ImageBitmap, factor: EnhanceFactor, onProgress?: (done: number, total: number) => void): Promise<HTMLCanvasElement> {
    let x4 = this.cache.get(bitmap);
    if (!x4) {
      x4 = this.runX4(bitmap, onProgress);
      this.cache.set(bitmap, x4);
      x4.catch(() => this.cache.delete(bitmap));
    }
    const big = await x4;
    if (factor === 4) return big;
    const c = document.createElement('canvas');
    c.width = bitmap.width * factor;
    c.height = bitmap.height * factor;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(big, 0, 0, c.width, c.height);
    return c;
  }

  private async runX4(bitmap: ImageBitmap, onProgress?: (done: number, total: number) => void): Promise<HTMLCanvasElement> {
    const src = document.createElement('canvas');
    src.width = bitmap.width;
    src.height = bitmap.height;
    const sctx = src.getContext('2d', { willReadFrequently: true })!;
    sctx.drawImage(bitmap, 0, 0);
    const input = sctx.getImageData(0, 0, src.width, src.height);

    const worker = (this.worker ??= new Worker(new URL('./upscale.worker.ts', import.meta.url), { type: 'module' }));
    const id = this.nextId++;
    const result = await new Promise<{ pixels: Uint8ClampedArray; width: number; height: number }>((resolve, reject) => {
      const onMessage = (event: MessageEvent<UpscaleMessage>) => {
        const msg = event.data;
        if (msg.id !== id) return;
        if (msg.type === 'progress') onProgress?.(msg.done, msg.total);
        else {
          worker.removeEventListener('message', onMessage);
          if (msg.type === 'done') resolve(msg);
          else reject(new Error(msg.error));
        }
      };
      worker.addEventListener('message', onMessage);
      const req: UpscaleRequest = { id, pixels: input.data, width: input.width, height: input.height, modelBase: MODEL_BASE };
      worker.postMessage(req, [input.data.buffer]);
    });

    const out = document.createElement('canvas');
    out.width = result.width;
    out.height = result.height;
    const octx = out.getContext('2d')!;
    const rgba = new ImageData(new Uint8ClampedArray(result.pixels), result.width, result.height);
    // Restore transparency from a smooth upscale of the original's alpha.
    const alpha = document.createElement('canvas');
    alpha.width = result.width;
    alpha.height = result.height;
    const actx = alpha.getContext('2d', { willReadFrequently: true })!;
    actx.imageSmoothingQuality = 'high';
    actx.drawImage(bitmap, 0, 0, result.width, result.height);
    const a = actx.getImageData(0, 0, result.width, result.height).data;
    let opaque = true;
    for (let i = 3; i < a.length; i += 4) if (a[i] < 255) { opaque = false; break; }
    if (!opaque) for (let i = 3; i < a.length; i += 4) rgba.data[i] = a[i];
    octx.putImageData(rgba, 0, 0);
    return out;
  }
}
