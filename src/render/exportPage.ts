import { StaticCanvas } from 'fabric';
import { imageStretch, nodeLabel } from '../document/ops';
import type { AssetId, DesignDocument, FontUse, Page } from '../document/types';
import { loadFontsForDocument } from './fonts';
import { relativeTo } from './imageCache';
import type { DecodedImage, ImageCache } from './imageCache';
import { createImageObject, createMissingImageObject, createTextObject, textLines } from './nodeFactory';
import type { Textbox } from 'fabric';

/**
 * Export contract
 *
 * - The output is exactly `width` x `height` pixels. It does not depend on editor
 *   zoom, window size or screen density, because it is drawn on its own canvas
 *   straight from the document.
 * - Original images are used, never the working previews.
 * - Hidden layers are left out. Locked layers are included.
 * - Anything outside the page (including shadows and outlines that spill over the
 *   edge) is cut off at the page edge.
 * - PNG keeps transparency when the page is transparent, unless a background is given.
 * - JPEG has no transparency: the page is flattened onto `background` (the page
 *   colour, or white for a transparent page).
 * - Fonts finish loading before text is laid out. Missing fonts and missing images
 *   stop the export unless `allowProblems` is set; they are never silently replaced.
 */

export type ExportFormat = 'png' | 'jpeg';

export interface ExportOptions {
  format: ExportFormat;
  /** Output width in pixels. Height follows the page's proportions. */
  width: number;
  /** 0 to 1, JPEG only. */
  quality?: number;
  /**
   * JPEG only: keep the file at or under this many bytes by lowering quality
   * (never below 0.3). If even that is too big, the smallest result is returned
   * with a warning.
   */
  maxBytes?: number;
  /** Overrides the page background. Required to be opaque for JPEG. */
  background?: string | null;
  /** Export even if images or fonts are missing. */
  allowProblems?: boolean;
  /** Use working previews instead of originals (for small thumbnails only). */
  usePreviews?: boolean;
  signal?: AbortSignal;
}

export interface ExportResult {
  blob: Blob;
  width: number;
  height: number;
  /** JPEG quality actually used (it can be lower than requested when `maxBytes` is set). */
  quality?: number;
  /** Things worth telling the person about, in plain language. */
  warnings: string[];
  /** Wrapped lines of every visible text layer, keyed by node id. Used to verify layout. */
  textLayout: Record<string, string[]>;
}

export class ExportError extends Error {
  constructor(
    message: string,
    readonly code: 'missing-assets' | 'missing-fonts' | 'too-large' | 'encode-failed' | 'cancelled',
    readonly details: { missingAssets?: AssetId[]; missingFonts?: FontUse[] } = {},
  ) {
    super(message);
    this.name = 'ExportError';
  }
}

/** Largest canvas browsers handle reliably. */
export const MAX_EXPORT_EDGE = 8192;
export const MAX_EXPORT_PIXELS = 8192 * 4608;

export function exportHeightFor(page: Pick<Page, 'width' | 'height'>, width: number): number {
  return Math.max(1, Math.round((width * page.height) / page.width));
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ExportError('Export cancelled.', 'cancelled');
}

export async function exportPage(
  doc: DesignDocument,
  page: Page,
  images: ImageCache,
  options: ExportOptions,
): Promise<ExportResult> {
  const width = Math.round(options.width);
  const height = exportHeightFor(page, width);
  if (!(width >= 1) || width > MAX_EXPORT_EDGE || height > MAX_EXPORT_EDGE || width * height > MAX_EXPORT_PIXELS) {
    throw new ExportError(
      `That size (${width} × ${height}) is too large to export reliably. The limit is ${MAX_EXPORT_EDGE} pixels on the longest side.`,
      'too-large',
    );
  }
  const scale = width / page.width;
  const warnings: string[] = [];
  const visible = page.nodes.filter((node) => node.visible);

  // 1. Fonts first: text must not be measured with a fallback font.
  const missingFonts = (await loadFontsForDocument(doc)).filter((font) =>
    visible.some((n) => n.type === 'text' && n.fontFamily === font.family && n.fontWeight === font.weight && n.fontStyle === font.style),
  );
  if (missingFonts.length && !options.allowProblems) {
    throw new ExportError(
      `Some text uses a font that is not available: ${[...new Set(missingFonts.map((f) => f.family))].join(', ')}.`,
      'missing-fonts',
      { missingFonts },
    );
  }
  throwIfCancelled(options.signal);

  // 2. Originals (or a photo's enlarged copy), one at a time to keep peak memory down.
  const decoded = new Map<AssetId, DecodedImage | null>();
  const decode = async (id: AssetId) => {
    if (!decoded.has(id)) decoded.set(id, options.usePreviews ? await images.getPreview(id) : await images.getFull(id));
    return decoded.get(id) ?? null;
  };
  const sources = new Map<string, DecodedImage | null>();
  const lostEnlargements = new Set<string>();
  for (const node of visible) {
    if (node.type !== 'image') continue;
    const original = doc.assets[node.assetId];
    let source: DecodedImage | null = null;
    if (node.upscale && original) {
      const enlarged = await decode(node.upscale.assetId);
      if (enlarged) source = relativeTo(enlarged, original.width, original.height);
      else lostEnlargements.add(node.id);
    }
    sources.set(node.id, source ?? (await decode(node.assetId)));
    throwIfCancelled(options.signal);
  }
  const missingAssets = [...new Set(visible.flatMap((node) => (node.type === 'image' && !sources.get(node.id) ? [node.assetId] : [])))];
  if (missingAssets.length && !options.allowProblems) {
    throw new ExportError(
      missingAssets.length === 1 ? 'One image is missing, so the export would be incomplete.' : `${missingAssets.length} images are missing, so the export would be incomplete.`,
      'missing-assets',
      { missingAssets },
    );
  }

  // 3. Draw on a canvas that has nothing to do with the editor's.
  let background: string | null = options.background === undefined ? page.background : options.background;
  if (options.format === 'jpeg' && !background) background = '#ffffff';

  const element = document.createElement('canvas');
  const canvas = new StaticCanvas(element, {
    width,
    height,
    enableRetinaScaling: false,
    renderOnAddRemove: false,
    backgroundColor: background ?? '',
  });
  const textLayout: Record<string, string[]> = {};
  try {
    canvas.setViewportTransform([scale, 0, 0, scale, 0, 0]);
    for (const node of visible) {
      if (node.type === 'image') {
        const source = sources.get(node.id);
        if (!source) {
          canvas.add(createMissingImageObject(node));
          continue;
        }
        // An enlarged copy counts: what matters is the pixels the photo is actually drawn from.
        const lost = lostEnlargements.has(node.id);
        if (lost) warnings.push(`The enlarged copy of "${nodeLabel(node)}" is missing, so its original was used.`);
        const stretch = imageStretch(lost ? { ...node, upscale: null } : node, scale);
        if (!options.usePreviews && stretch > 150) {
          warnings.push(
            node.upscale && !lost
              ? `"${nodeLabel(node)}" is stretched to ${Math.round(stretch)}% of its enlarged resolution and may look soft.`
              : `"${nodeLabel(node)}" is stretched to ${Math.round(stretch)}% of its original resolution and may look soft. Upscale the photo to sharpen it.`,
          );
        }
        canvas.add(createImageObject(node, source));
      } else {
        const obj = createTextObject(node);
        textLayout[node.id] = textLines(obj as Textbox);
        canvas.add(obj);
      }
    }
    canvas.renderAll();
    throwIfCancelled(options.signal);

    const encode = (type: string, quality?: number) =>
      new Promise<Blob | null>((resolve) => element.toBlob(resolve, type, quality));
    const failed = () =>
      new ExportError(
        'The image could not be created. This usually means the computer ran out of memory; try a smaller size.',
        'encode-failed',
      );

    let blob: Blob | null;
    let quality: number | undefined;
    if (options.format === 'png') {
      blob = await encode('image/png');
    } else {
      quality = Math.min(1, Math.max(0.01, options.quality ?? 0.92));
      blob = await encode('image/jpeg', quality);
      if (blob && options.maxBytes && blob.size > options.maxBytes) {
        // The page is already drawn; only the encoding is repeated.
        let low = 0.3;
        let high = quality;
        let best: { blob: Blob; quality: number } | null = null;
        let smallest: { blob: Blob; quality: number } = { blob, quality };
        for (let i = 0; i < 7; i++) {
          throwIfCancelled(options.signal);
          const q = i === 0 ? low : (low + high) / 2;
          const attempt = await encode('image/jpeg', q);
          if (!attempt) throw failed();
          if (attempt.size < smallest.blob.size) smallest = { blob: attempt, quality: q };
          if (attempt.size <= options.maxBytes) {
            best = { blob: attempt, quality: q };
            low = q;
          } else {
            if (i === 0) break; // even the lowest quality is too big
            high = q;
          }
        }
        const chosen = best ?? smallest;
        blob = chosen.blob;
        quality = chosen.quality;
        if (!best) {
          warnings.push(
            `The file could not be made smaller than ${Math.ceil(chosen.blob.size / 1024)} KB at this size. Choose a smaller size to go lower.`,
          );
        }
      }
    }
    if (!blob) throw failed();
    if (missingFonts.length) warnings.push('Some text was drawn in a substitute font because its font is missing.');
    if (missingAssets.length) warnings.push('Missing images were left as placeholders.');
    return { blob, width, height, quality, warnings, textLayout };
  } finally {
    await canvas.dispose();
    // Release the drawing surface straight away rather than waiting for garbage collection.
    element.width = 0;
    element.height = 0;
  }
}
