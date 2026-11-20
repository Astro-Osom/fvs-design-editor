import type { UpscaleJob, UpscaleProvider, WorkerMessage } from './protocol';

/**
 * Runs an enlarging job in a worker and reports back. One worker per job: it is
 * created when the job starts and gone when it ends, so cancelling is immediate
 * and nothing lingers in memory.
 */

export class UpscaleError extends Error {
  constructor(
    message: string,
    readonly code: 'cancelled' | 'memory' | 'failed',
  ) {
    super(message);
    this.name = 'UpscaleError';
  }
}

export interface UpscaleRunOptions {
  signal?: AbortSignal;
  onProgress?(done: number, total: number): void;
  /** Called once it is known what is doing the work. */
  onProvider?(provider: UpscaleProvider): void;
}

export interface UpscaleResult {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  provider: UpscaleProvider;
}

export const OUT_OF_MEMORY_MESSAGE =
  'The computer ran out of memory while enlarging this photo. Try a smaller enlargement, or close other tabs and apps and try again.';

export const CANNOT_RUN_MESSAGE = 'The enlarging helper could not run on this computer.';

/** Largest result that is attempted. Beyond this, memory use becomes unreliable. */
export const MAX_UPSCALED_EDGE = 8192;
export const MAX_UPSCALED_PIXELS = 40_000_000;

export function upscaleFits(width: number, height: number, factor: number): boolean {
  const w = width * factor;
  const h = height * factor;
  return Math.max(w, h) <= MAX_UPSCALED_EDGE && w * h <= MAX_UPSCALED_PIXELS;
}

export function runUpscale(job: UpscaleJob, options: UpscaleRunOptions = {}): Promise<UpscaleResult> {
  return new Promise<UpscaleResult>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new UpscaleError('Enlarging was cancelled.', 'cancelled'));
      return;
    }
    let worker: Worker;
    try {
      worker = new Worker(new URL('./upscale.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      reject(new UpscaleError('This browser could not start the enlarging tool.', 'failed'));
      return;
    }
    const finish = (settle: () => void) => {
      options.signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      settle();
    };
    const onAbort = () => finish(() => reject(new UpscaleError('Enlarging was cancelled.', 'cancelled')));
    options.signal?.addEventListener('abort', onAbort);

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === 'progress') options.onProgress?.(message.done, message.total);
      else if (message.type === 'provider') options.onProvider?.(message.provider);
      else if (message.type === 'done') {
        finish(() => resolve({ rgba: new Uint8ClampedArray(message.rgba), width: message.width, height: message.height, provider: message.provider }));
      } else {
        // The technical reason goes to the console; the person gets plain words.
        console.error('Upscale failed:', message.message);
        finish(() => reject(new UpscaleError(message.code === 'memory' ? OUT_OF_MEMORY_MESSAGE : CANNOT_RUN_MESSAGE, message.code)));
      }
    };
    // A worker that dies outright has almost always run out of memory.
    worker.onerror = (event) => {
      event.preventDefault?.();
      finish(() => reject(new UpscaleError(OUT_OF_MEMORY_MESSAGE, 'memory')));
    };
    try {
      // The photo is copied to the worker, so the caller's copy stays usable for the comparison.
      const transfer: Transferable[] = [];
      worker.postMessage(job, transfer);
    } catch (error) {
      finish(() => reject(new UpscaleError(OUT_OF_MEMORY_MESSAGE, 'memory')));
      void error;
    }
  });
}
