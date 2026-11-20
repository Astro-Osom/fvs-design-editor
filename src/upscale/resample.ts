/**
 * A plain high-quality resize (Lanczos, three lobes), written out here so it gives
 * the same result on every computer and browser. It makes a picture larger and
 * smoother but adds no detail. It is used for the transparency of a photo, and as
 * the honest fallback when the enlarging model cannot run.
 */

function lanczos(x: number): number {
  if (x === 0) return 1;
  if (x <= -3 || x >= 3) return 0;
  const px = Math.PI * x;
  return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
}

interface Taps {
  first: Int32Array;
  weights: Float32Array;
  count: number;
}

/** A straight-line blend between neighbours. Softer than Lanczos, but it can never overshoot. */
function linear(x: number): number {
  const distance = Math.abs(x);
  return distance >= 1 ? 0 : 1 - distance;
}

export type ResampleFilter = 'lanczos' | 'linear';

/** For each output position, which source positions contribute and by how much. */
function tapsFor(sourceSize: number, targetSize: number, filter: ResampleFilter): Taps {
  const ratio = sourceSize / targetSize;
  // When shrinking, widen the filter so nothing is skipped.
  const stretch = Math.max(1, ratio);
  const reach = filter === 'lanczos' ? 3 : 1;
  const kernel = filter === 'lanczos' ? lanczos : linear;
  const count = Math.ceil(reach * stretch) * 2 + 1;
  const first = new Int32Array(targetSize);
  const weights = new Float32Array(targetSize * count);
  for (let i = 0; i < targetSize; i++) {
    const centre = (i + 0.5) * ratio - 0.5;
    const start = Math.floor(centre) - Math.floor(count / 2);
    first[i] = start;
    let total = 0;
    for (let k = 0; k < count; k++) {
      const w = kernel((start + k - centre) / stretch);
      weights[i * count + k] = w;
      total += w;
    }
    for (let k = 0; k < count; k++) weights[i * count + k]! /= total;
  }
  return { first, weights, count };
}

/**
 * Resize interleaved 8-bit pixels (`channels` values per pixel) to a new size.
 * Edge pixels are repeated where the filter reaches past the picture.
 */
export function resample(
  source: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  channels: number,
  targetWidth: number,
  targetHeight: number,
  filter: ResampleFilter = 'lanczos',
): Uint8ClampedArray {
  if (!(width >= 1 && height >= 1 && targetWidth >= 1 && targetHeight >= 1)) throw new RangeError('Invalid size');
  // Across first, into floats; then down, into bytes.
  const across = tapsFor(width, targetWidth, filter);
  const wide = new Float32Array(targetWidth * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < targetWidth; x++) {
      const base = x * across.count;
      for (let c = 0; c < channels; c++) {
        let sum = 0;
        for (let k = 0; k < across.count; k++) {
          const sx = Math.min(width - 1, Math.max(0, across.first[x]! + k));
          sum += source[(y * width + sx) * channels + c]! * across.weights[base + k]!;
        }
        wide[(y * targetWidth + x) * channels + c] = sum;
      }
    }
  }
  const down = tapsFor(height, targetHeight, filter);
  const out = new Uint8ClampedArray(targetWidth * targetHeight * channels);
  for (let y = 0; y < targetHeight; y++) {
    const base = y * down.count;
    for (let x = 0; x < targetWidth; x++) {
      for (let c = 0; c < channels; c++) {
        let sum = 0;
        for (let k = 0; k < down.count; k++) {
          const sy = Math.min(height - 1, Math.max(0, down.first[y]! + k));
          sum += wide[(sy * targetWidth + x) * channels + c]! * down.weights[base + k]!;
        }
        out[(y * targetWidth + x) * channels + c] = sum;
      }
    }
  }
  return out;
}

/** Whether any pixel of an RGBA picture is see-through. */
export function hasTransparency(rgba: Uint8ClampedArray | Uint8Array): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return true;
  return false;
}

/**
 * Enlarge only the alpha channel of an RGBA picture and write it into `target`
 * (also RGBA). A straight-line blend is used, so fully see-through and fully solid
 * areas stay exactly that: a sharper filter would leave a faint halo around edges.
 */
export function resampleAlphaInto(
  source: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  target: Uint8ClampedArray,
  targetWidth: number,
  targetHeight: number,
): void {
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = source[i * 4 + 3]!;
  const scaled = resample(alpha, width, height, 1, targetWidth, targetHeight, 'linear');
  for (let i = 0; i < scaled.length; i++) target[i * 4 + 3] = scaled[i]!;
}
