import { sha256Hex } from '../assets/assetStore';
import { findDerivedAsset, findNode, firstPage, imageStretch, setImageUpscale } from '../document/ops';
import type { AssetInfo, DesignDocument, ImageNode, NodeId, UpscaleMethod } from '../document/types';
import { decodeImage } from '../render/imageCache';
import { runUpscale, UpscaleError, upscaleFits } from '../upscale/engine';
import { downloadModel, storedModel, upscaleModel } from '../upscale/model';
import type { UpscaleProvider } from '../upscale/protocol';
import { assets } from './services';
import { commitDoc, currentDoc, selectDoc, store } from './store';

/** Enlarging photos: working out what is sensible, doing it, and recording it in the design. */

/** The width in pixels the person most likely wants to export at: 4K, or the page if that is larger. */
export const SHARP_TARGET_WIDTH = 3840;

export interface UpscaleChoice {
  factor: 2 | 4;
  width: number;
  height: number;
  /** False when the result would be too large to make reliably. */
  fits: boolean;
}

export interface UpscaleSituation {
  node: ImageNode;
  asset: AssetInfo;
  /** Percent the ORIGINAL is stretched on the page: over 100 means it looks soft at the page's own size. */
  stretchOnPage: number;
  /** Percent the ORIGINAL is stretched when the page is exported at 4K. */
  stretchAt4k: number;
  /** The same two figures for what is drawn now (the enlarged copy, if there is one). */
  currentStretchOnPage: number;
  currentStretchAt4k: number;
  choices: UpscaleChoice[];
  /** The smallest enlargement that keeps the photo sharp at 4K, or null if it already is. */
  recommended: 2 | 4 | null;
}

export function upscaleSituation(doc: DesignDocument, nodeId: NodeId): UpscaleSituation | null {
  const node = findNode(doc, nodeId)?.node;
  if (!node || node.type !== 'image') return null;
  const asset = doc.assets[node.assetId];
  if (!asset) return null;
  const page = firstPage(doc);
  const exportScale = Math.max(1, SHARP_TARGET_WIDTH / page.width);
  const original = { ...node, upscale: null };
  const choices: UpscaleChoice[] = ([2, 4] as const).map((factor) => ({
    factor,
    width: asset.width * factor,
    height: asset.height * factor,
    fits: upscaleFits(asset.width, asset.height, factor),
  }));
  const stretchAt4k = imageStretch(original, exportScale);
  const wanted = stretchAt4k <= 100 ? null : stretchAt4k <= 200 ? 2 : 4;
  const available = choices.filter((choice) => choice.fits).map((choice) => choice.factor);
  const recommended = wanted === null ? null : (available.find((factor) => factor >= wanted) ?? available.at(-1) ?? null);
  return {
    node,
    asset,
    stretchOnPage: imageStretch(original, 1),
    stretchAt4k,
    currentStretchOnPage: imageStretch(node, 1),
    currentStretchAt4k: imageStretch(node, exportScale),
    choices,
    recommended,
  };
}

export type UpscaleStage = 'downloading' | 'working' | 'finishing';

export interface ComputeUpscaleOptions {
  signal?: AbortSignal;
  onStage?(stage: UpscaleStage): void;
  /** Download progress, in bytes. */
  onDownload?(received: number, total: number): void;
  /** Work progress, in parts of the photo. */
  onProgress?(done: number, total: number): void;
  onProvider?(provider: UpscaleProvider): void;
  /** 'processor' skips the graphics card. */
  device?: 'auto' | 'processor';
}

export interface ComputedUpscale {
  nodeId: NodeId;
  /** The record for the enlarged copy. */
  derived: AssetInfo;
  /** Its bytes, or null when the design already holds this exact copy. */
  bytes: Uint8Array | null;
  /** The original and the enlarged copy, for the before and after view. */
  before: HTMLCanvasElement;
  after: HTMLCanvasElement;
  provider: UpscaleProvider;
  milliseconds: number;
}

function canvasFrom(source: ImageBitmap | { rgba: Uint8ClampedArray; width: number; height: number }): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext('2d', { willReadFrequently: 'rgba' in source ? false : true });
  if (!context) throw new UpscaleError('The computer ran out of memory while preparing this photo.', 'memory');
  if ('rgba' in source) context.putImageData(new ImageData(source.rgba as Uint8ClampedArray<ArrayBuffer>, source.width, source.height), 0, 0);
  else context.drawImage(source, 0, 0);
  return canvas;
}

async function decodeToCanvas(id: string): Promise<HTMLCanvasElement | null> {
  const stored = await assets.get(id);
  if (!stored) return null;
  const bitmap = await decodeImage(stored.bytes, stored.mime);
  try {
    return canvasFrom(bitmap);
  } finally {
    bitmap.close();
  }
}

function encodePng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(new UpscaleError('The computer ran out of memory while saving the enlarged photo.', 'memory'));
      else void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
    }, 'image/png');
  });
}

/**
 * Make an enlarged copy of a photo. Nothing in the design changes until
 * `applyUpscale` is called with the result, so this can be cancelled or thrown
 * away freely.
 */
export async function computeUpscale(nodeId: NodeId, factor: 2 | 4, method: UpscaleMethod, options: ComputeUpscaleOptions = {}): Promise<ComputedUpscale> {
  const started = performance.now();
  const doc = currentDoc();
  const situation = upscaleSituation(doc, nodeId);
  if (!situation) throw new UpscaleError('That photo is no longer in the design.', 'failed');
  const { asset } = situation;
  if (!upscaleFits(asset.width, asset.height, factor)) {
    throw new UpscaleError('The enlarged photo would be too large to make reliably. Choose a smaller enlargement.', 'failed');
  }
  const before = await decodeToCanvas(asset.id);
  if (!before) throw new UpscaleError('The original photo is missing, so it cannot be enlarged.', 'failed');

  // The same photo, enlarged the same way, is not computed twice.
  const existing = findDerivedAsset(doc, asset.id, method, factor);
  if (existing) {
    const after = await decodeToCanvas(existing.id);
    if (after) return { nodeId, derived: existing, bytes: null, before, after, provider: 'none', milliseconds: performance.now() - started };
  }

  let model: Uint8Array | null = null;
  if (method !== 'resample') {
    model = await storedModel();
    if (!model) {
      options.onStage?.('downloading');
      model = await downloadModel({ ...(options.signal ? { signal: options.signal } : {}), ...(options.onDownload ? { onProgress: options.onDownload } : {}) });
    }
  }

  options.onStage?.('working');
  const context = before.getContext('2d', { willReadFrequently: true })!;
  const pixels = context.getImageData(0, 0, before.width, before.height);
  const result = await runUpscale(
    {
      rgba: pixels.data.buffer as ArrayBuffer,
      width: before.width,
      height: before.height,
      factor,
      method,
      ...(model ? { model: model.buffer as ArrayBuffer, modelScale: upscaleModel().scale } : {}),
      device: options.device ?? 'auto',
    },
    options,
  );

  options.onStage?.('finishing');
  const after = canvasFrom(result);
  const bytes = await encodePng(after);
  if (options.signal?.aborted) throw new UpscaleError('Enlarging was cancelled.', 'cancelled');
  const derived: AssetInfo = {
    id: await sha256Hex(bytes),
    kind: 'image',
    mime: 'image/png',
    bytes: bytes.length,
    width: result.width,
    height: result.height,
    name: `${asset.name.replace(/\.[a-z0-9]+$/i, '')} (enlarged ${factor}x).png`,
    derivedFrom: { assetId: asset.id, method, factor },
  };
  return { nodeId, derived, bytes, before, after, provider: result.provider, milliseconds: performance.now() - started };
}

/** Use an enlarged copy for a photo layer. One undo step. The original is kept. */
export async function applyUpscale(computed: ComputedUpscale): Promise<boolean> {
  if (computed.bytes && !(await assets.has(computed.derived.id))) {
    await assets.put({ id: computed.derived.id, mime: computed.derived.mime, bytes: computed.bytes });
  }
  if (!selectDoc(store.getState())) return false;
  return commitDoc(setImageUpscale(currentDoc(), computed.nodeId, computed.derived), 'Upscale photo');
}

/** Go back to drawing a photo from its original. One undo step. */
export function removeUpscale(nodeId: NodeId): boolean {
  return commitDoc(setImageUpscale(currentDoc(), nodeId, null), 'Turn off upscaling');
}

/** Whether the enlarging model is already on this machine. */
export async function upscaleModelReady(): Promise<boolean> {
  return (await storedModel()) !== null;
}
