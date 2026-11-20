import { sha256Hex } from '../assets/assetStore';
import { openDatabase, requestToPromise, transactionDone } from '../storage/idb';

/**
 * The model that enlarges photos, and how it gets onto this machine.
 *
 * The model file is not part of the app or the repository. It is downloaded the
 * first time it is needed, checked against a known hash, and kept in browser
 * storage so it works offline from then on. See docs/research/upscaling.md.
 */

export interface ModelSource {
  url: string;
  bytes: number;
  sha256: string;
}

export interface UpscaleModel {
  id: 'realesr-general-x4v3';
  /** How many times larger each side of the model's output is. */
  scale: number;
  license: string;
  /** Where the file can be fetched from, in order of preference. Every address is pinned to an exact revision. */
  sources: ModelSource[];
}

/**
 * Real-ESRGAN "general x4 v3" (Xintao Wang), BSD-3-Clause, 4.9 MB.
 * Both files are third-party ONNX conversions that were checked to contain the
 * official weights bit for bit.
 */
export const REAL_ESRGAN_GENERAL: UpscaleModel = {
  id: 'realesr-general-x4v3',
  scale: 4,
  license: 'BSD-3-Clause',
  sources: [
    {
      url: 'https://huggingface.co/thisismert/real-esrgan-onnx/resolve/238b42ef61dcf2cd2c8b3632208ae29b847f194d/onnx/realesr-general-x4v3.onnx',
      bytes: 4_866_418,
      sha256: '5518a106453e751655edc12f208973207ab8355d0cafc1816b8a9041b01810dd',
    },
    {
      url: 'https://huggingface.co/skillsafe-ai/realesr-general-x4v3/resolve/042a40bc4c918349ad3e2e607a68ae509a4c27b5/model.onnx',
      bytes: 4_866_428,
      sha256: 'a946f7a9397021b9b6b7e71df3d2821b04cc09ff244423b7ca79cb191ce4a00e',
    },
  ],
};

/**
 * The model in use. Automated tests replace the sources with a tiny stand-in
 * model (by setting `__FVS_TEST_UPSCALE_SOURCES__` before the app starts), so
 * they never download the real one.
 */
export function upscaleModel(): UpscaleModel {
  const override = (globalThis as { __FVS_TEST_UPSCALE_SOURCES__?: ModelSource[] }).__FVS_TEST_UPSCALE_SOURCES__;
  return override?.length ? { ...REAL_ESRGAN_GENERAL, sources: override } : REAL_ESRGAN_GENERAL;
}

export function modelDownloadBytes(model: UpscaleModel = upscaleModel()): number {
  return model.sources[0]!.bytes;
}

export class ModelError extends Error {
  constructor(
    message: string,
    readonly code: 'offline' | 'bad-response' | 'cancelled' | 'storage',
  ) {
    super(message);
    this.name = 'ModelError';
  }
}

interface StoredModel {
  id: string;
  sha256: string;
  bytes: Uint8Array;
}

/** The model from browser storage, or null if it has not been downloaded (or no longer matches a known file). */
export async function storedModel(model: UpscaleModel = upscaleModel()): Promise<Uint8Array | null> {
  try {
    const db = await openDatabase();
    const row = await requestToPromise<StoredModel | undefined>(db.transaction('models', 'readonly').objectStore('models').get(model.id));
    if (!row || !model.sources.some((source) => source.sha256 === row.sha256)) return null;
    return new Uint8Array(row.bytes);
  } catch {
    return null;
  }
}

export interface ModelDownloadOptions {
  signal?: AbortSignal;
  /** Bytes received so far, out of how many. */
  onProgress?(received: number, total: number): void;
  fetch?: typeof fetch;
}

async function fetchSource(source: ModelSource, options: ModelDownloadOptions): Promise<Uint8Array | 'unreachable' | 'wrong'> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(source.url, { signal: options.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch {
    if (options.signal?.aborted) throw new ModelError('The download was cancelled.', 'cancelled');
    return 'unreachable';
  }
  if (!response.ok) return 'wrong';
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    const reader = response.body?.getReader();
    if (!reader) {
      chunks.push(new Uint8Array(await response.arrayBuffer()));
      received = chunks[0]!.length;
    } else {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        // A file much larger than expected is not the model; stop reading it.
        if (received > source.bytes * 2 + 1024) return 'wrong';
        options.onProgress?.(Math.min(received, source.bytes), source.bytes);
      }
    }
  } catch {
    if (options.signal?.aborted) throw new ModelError('The download was cancelled.', 'cancelled');
    return 'unreachable';
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  // Only the exact file that was reviewed is ever run.
  return (await sha256Hex(bytes)) === source.sha256 ? bytes : 'wrong';
}

/** Download the model, check it, keep it for next time, and return it. */
export async function downloadModel(options: ModelDownloadOptions = {}, model: UpscaleModel = upscaleModel()): Promise<Uint8Array> {
  let sawWrongFile = false;
  for (const source of model.sources) {
    const result = await fetchSource(source, options);
    if (result === 'wrong') {
      sawWrongFile = true;
      continue;
    }
    if (result === 'unreachable') continue;
    try {
      const db = await openDatabase();
      const tx = db.transaction('models', 'readwrite');
      tx.objectStore('models').put({ id: model.id, sha256: source.sha256, bytes: result } satisfies StoredModel);
      await transactionDone(tx);
    } catch {
      // It can still be used now; it will simply be downloaded again next time.
    }
    return result;
  }
  if (sawWrongFile) {
    throw new ModelError('The download did not match the file the editor expects, so it was not used.', 'bad-response');
  }
  throw new ModelError('The download could not be reached. Check your internet connection and try again.', 'offline');
}
