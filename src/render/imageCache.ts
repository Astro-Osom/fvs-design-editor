import type { AssetStore } from '../assets/assetStore';
import type { AssetId } from '../document/types';

/** A decoded image ready to draw. */
export interface DecodedImage {
  element: HTMLCanvasElement;
  /** Element pixels per source pixel (1 for full resolution, less for a working preview). */
  scale: number;
  sourceWidth: number;
  sourceHeight: number;
}

const relativeViews = new WeakMap<DecodedImage, Map<string, DecodedImage>>();

/**
 * The same picture, described against a differently sized original.
 *
 * A photo layer's crop is always in the pixels of its ORIGINAL image. When the
 * layer draws from an enlarged copy instead, this gives that copy the original's
 * pixel grid: `scale` becomes element pixels per original pixel, so every piece
 * of crop and placement maths works unchanged. The result is remembered, so the
 * same input always gives the same object.
 */
export function relativeTo(image: DecodedImage, originalWidth: number, originalHeight: number): DecodedImage {
  if (image.sourceWidth === originalWidth && image.sourceHeight === originalHeight) return image;
  let views = relativeViews.get(image);
  if (!views) relativeViews.set(image, (views = new Map()));
  const key = `${originalWidth}x${originalHeight}`;
  let view = views.get(key);
  if (!view) {
    view = { element: image.element, scale: image.element.width / originalWidth, sourceWidth: originalWidth, sourceHeight: originalHeight };
    views.set(key, view);
  }
  return view;
}

/** Longest edge of the working preview used while editing. Export always uses the original. */
export const PREVIEW_MAX_EDGE = 2048;

export const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];

/**
 * Decode image bytes, applying EXIF orientation. The object URL-free path:
 * bytes -> Blob -> ImageBitmap, with nothing left behind to revoke.
 */
export async function decodeImage(bytes: Uint8Array, mime: string): Promise<ImageBitmap> {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  return createImageBitmap(blob, { imageOrientation: 'from-image' });
}

function drawToCanvas(bitmap: ImageBitmap, scale: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create a drawing surface for an image');
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Decodes assets for drawing. Working previews are cached per asset; full-resolution
 * decodes are handed to the caller and not kept, so memory does not grow with use.
 */
export class ImageCache {
  private readonly previews = new Map<AssetId, Promise<DecodedImage | null>>();

  constructor(private readonly store: AssetStore) {}

  /** A downscaled copy for editing. Resolves to null if the asset is missing or unreadable. */
  getPreview(id: AssetId): Promise<DecodedImage | null> {
    let pending = this.previews.get(id);
    if (!pending) {
      pending = this.decode(id, PREVIEW_MAX_EDGE).catch(() => null);
      this.previews.set(id, pending);
      // Do not cache a failure: the asset may be supplied later (for example by re-linking).
      void pending.then((result) => {
        if (!result && this.previews.get(id) === pending) this.previews.delete(id);
      });
    }
    return pending;
  }

  /** The original at full resolution, for export. Not cached. */
  getFull(id: AssetId): Promise<DecodedImage | null> {
    return this.decode(id, Infinity).catch(() => null);
  }

  /** Forget previews for assets that are no longer in use. */
  retainOnly(ids: ReadonlySet<AssetId>): void {
    for (const id of this.previews.keys()) if (!ids.has(id)) this.previews.delete(id);
  }

  clear(): void {
    this.previews.clear();
  }

  get size(): number {
    return this.previews.size;
  }

  private async decode(id: AssetId, maxEdge: number): Promise<DecodedImage | null> {
    const stored = await this.store.get(id);
    if (!stored) return null;
    const bitmap = await decodeImage(stored.bytes, stored.mime);
    try {
      const longest = Math.max(bitmap.width, bitmap.height);
      const scale = longest > maxEdge ? maxEdge / longest : 1;
      const element = drawToCanvas(bitmap, scale);
      return {
        element,
        // Use the real ratio after rounding so crop maths stays exact.
        scale: element.width / bitmap.width,
        sourceWidth: bitmap.width,
        sourceHeight: bitmap.height,
      };
    } finally {
      bitmap.close();
    }
  }
}
