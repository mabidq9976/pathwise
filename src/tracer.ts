// Main-thread client for the trace worker. A new request cancels the one in
// flight by restarting the worker, so slider drags never queue up stale work.
import type { PrecisionOptions } from './precision/engine.ts';
import type { Fidelity } from './quality.ts';
import type { TraceRequest, TraceResponse } from './trace.worker.ts';
import type { VectorDoc } from './vector.ts';

export interface TraceOutput {
  doc: VectorDoc;
  ms: number;
  fidelity: Fidelity | null;
}

export type EngineJob = { engine: 'classic'; config: Record<string, unknown> } | { engine: 'precision'; options: PrecisionOptions };

export class CancelledError extends Error {
  constructor() {
    super('Trace cancelled');
  }
}

interface Pending {
  id: number;
  resolve: (out: TraceOutput) => void;
  reject: (err: Error) => void;
}

export class Tracer {
  private worker: Worker | null = null;
  private pending: Pending | null = null;
  private nextId = 1;

  trace(image: ImageData, job: EngineJob): Promise<TraceOutput> {
    if (this.pending) {
      this.pending.reject(new CancelledError());
      this.pending = null;
      this.restart();
    }
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<TraceOutput>((resolve, reject) => {
      this.pending = { id, resolve, reject };
      const request: TraceRequest = {
        id,
        pixels: new Uint8Array(image.data.buffer.slice(0)),
        width: image.width,
        height: image.height,
        ...job,
      };
      worker.postMessage(request, [request.pixels.buffer]);
    });
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./trace.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (event: MessageEvent<TraceResponse>) => this.settle(event.data);
      this.worker.onerror = (event) => {
        event.preventDefault();
        const pending = this.pending;
        this.pending = null;
        this.restart();
        pending?.reject(new Error(event.message || 'The tracing worker crashed'));
      };
    }
    return this.worker;
  }

  private settle(reply: TraceResponse) {
    const pending = this.pending;
    if (!pending || pending.id !== reply.id) return;
    this.pending = null;
    if (reply.ok) {
      pending.resolve({ doc: reply.doc, ms: reply.ms, fidelity: reply.fidelity });
    } else {
      // A Rust panic can leave the WASM instance unusable; start clean next time.
      this.restart();
      pending.reject(new Error(reply.error));
    }
  }

  private restart() {
    this.worker?.terminate();
    this.worker = null;
  }
}
