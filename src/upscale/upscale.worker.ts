/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/webgpu';
import type { UpscaleJob, UpscaleProvider, WorkerMessage } from './protocol';
import { hasTransparency, resample, resampleAlphaInto } from './resample';
import { extractTile, placeTile, planTiles } from './tiles';

/**
 * Enlarges one photo, off the main thread so the editor stays responsive.
 *
 * The model runs on the graphics card (WebGPU) where that works, and on the
 * processor (WebAssembly) otherwise. The photo is processed in tiles so memory
 * use does not grow with the size of the photo. To cancel, the page simply
 * terminates this worker.
 */

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (message: WorkerMessage, transfer: Transferable[] = []) => scope.postMessage(message, transfer);

// Tile sizes: what the model is given is core + 2 * margin on each side.
const MARGIN = 16;
const CORE = { webgpu: 224, wasm: 96 } as const;

ort.env.logLevel = 'error';
// If the runtime cannot start, fail instead of waiting for ever.
ort.env.wasm.initTimeout = 60_000;
// One thread on the processor. Several threads were tried (they need the page to be
// isolated from other origins) and the runtime failed to start inside this worker,
// so that is left for later. See docs/research/upscaling.md.
ort.env.wasm.numThreads = 1;

function isMemoryError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /out of memory|allocation failed|failed to allocate|bad_alloc|std::bad|OOM|Array buffer allocation|Invalid typed array length|memory access out of bounds/i.test(text);
}

async function withModel(job: UpscaleJob, source: Uint8ClampedArray, provider: Exclude<UpscaleProvider, 'none'>): Promise<Uint8ClampedArray> {
  const session = await ort.InferenceSession.create(new Uint8Array(job.model!), { executionProviders: [provider], graphOptimizationLevel: 'all' });
  try {
    post({ type: 'provider', provider });
    const modelScale = job.modelScale ?? 4;
    const reduce = modelScale / job.factor;
    if (reduce !== 1 && reduce !== 2) throw new Error(`This model cannot enlarge ${job.factor} times.`);
    const outWidth = job.width * job.factor;
    const outHeight = job.height * job.factor;
    const out = new Uint8ClampedArray(outWidth * outHeight * 4);
    const tiles = planTiles(job.width, job.height, CORE[provider], MARGIN);
    const inputName = session.inputNames[0]!;
    const outputName = session.outputNames[0]!;
    post({ type: 'progress', done: 0, total: tiles.length });
    for (const [index, tile] of tiles.entries()) {
      const size = tile.inputSize;
      const input = new ort.Tensor('float32', extractTile(source, job.width, job.height, tile), [1, 3, size, size]);
      const results = await session.run({ [inputName]: input });
      const result = results[outputName]!;
      const side = size * modelScale;
      if (result.dims.length !== 4 || result.dims[1] !== 3 || result.dims[2] !== side || result.dims[3] !== side) {
        throw new Error('The model returned a result of an unexpected size.');
      }
      placeTile(out, outWidth, tile, (await result.getData()) as Float32Array, modelScale, reduce);
      input.dispose();
      result.dispose();
      post({ type: 'progress', done: index + 1, total: tiles.length });
    }
    // The model works on colour only. See-through photos keep their transparency, enlarged plainly.
    if (hasTransparency(source)) resampleAlphaInto(source, job.width, job.height, out, outWidth, outHeight);
    return out;
  } finally {
    await session.release().catch(() => undefined);
  }
}

async function run(job: UpscaleJob): Promise<void> {
  const source = new Uint8ClampedArray(job.rgba);
  const outWidth = job.width * job.factor;
  const outHeight = job.height * job.factor;

  if (job.method === 'resample') {
    post({ type: 'provider', provider: 'none' });
    post({ type: 'progress', done: 0, total: 1 });
    const out = resample(source, job.width, job.height, 4, outWidth, outHeight);
    post({ type: 'progress', done: 1, total: 1 });
    post({ type: 'done', rgba: out.buffer as ArrayBuffer, width: outWidth, height: outHeight, provider: 'none' }, [out.buffer as ArrayBuffer]);
    return;
  }

  const hasGpu = job.device !== 'processor' && 'gpu' in navigator;
  const providers: Exclude<UpscaleProvider, 'none'>[] = hasGpu ? ['webgpu', 'wasm'] : ['wasm'];
  let lastError: unknown;
  for (const provider of providers) {
    try {
      const out = await withModel(job, source, provider);
      post({ type: 'done', rgba: out.buffer as ArrayBuffer, width: outWidth, height: outHeight, provider }, [out.buffer as ArrayBuffer]);
      return;
    } catch (error) {
      // If the graphics card cannot do it, the processor gets a turn.
      lastError = error;
    }
  }
  throw lastError;
}

scope.onmessage = (event: MessageEvent<UpscaleJob>) => {
  run(event.data).catch((error: unknown) => {
    post({ type: 'error', code: isMemoryError(error) ? 'memory' : 'failed', message: error instanceof Error ? error.message : String(error) });
  });
};
