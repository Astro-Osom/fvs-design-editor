import type { UpscaleMethod } from '../document/types';

/** Messages between the page and the worker that enlarges photos. */

export type UpscaleProvider = 'webgpu' | 'wasm' | 'none';

export interface UpscaleJob {
  /** The photo as RGBA, 8 bits per channel, not premultiplied. */
  rgba: ArrayBuffer;
  width: number;
  height: number;
  /** How many times larger each side should become. */
  factor: number;
  method: UpscaleMethod;
  /** The model file, for methods that use one. */
  model?: ArrayBuffer;
  /** How many times larger the model itself makes each side. */
  modelScale?: number;
  /** 'processor' skips the graphics card. */
  device?: 'auto' | 'processor';
}

export type WorkerMessage =
  | { type: 'provider'; provider: UpscaleProvider }
  | { type: 'progress'; done: number; total: number }
  | { type: 'done'; rgba: ArrayBuffer; width: number; height: number; provider: UpscaleProvider }
  | { type: 'error'; code: 'memory' | 'failed'; message: string };
