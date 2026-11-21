/**
 * Enlarging a picture in pieces.
 *
 * A model cannot take a large photo in one go without exhausting memory, so the
 * photo is cut into square tiles. Each tile is given some of its surroundings
 * (the margin) so the model sees context at the tile's edges; only the middle
 * (the core) of each result is kept. The cores tile the picture exactly, so
 * every output pixel is written once and there are no seams to blend.
 *
 * Everything here is plain arithmetic on arrays, so it is tested without a browser.
 */

export interface Tile {
  /** Top-left of the square given to the model, in source pixels. May be negative or run past the edges. */
  inputX: number;
  inputY: number;
  /** Side of that square: core + 2 * margin. The same for every tile. */
  inputSize: number;
  /** The part of the source this tile is responsible for. */
  coreX: number;
  coreY: number;
  coreWidth: number;
  coreHeight: number;
}

/** Cut a picture into tiles whose cores cover it exactly once. */
export function planTiles(width: number, height: number, core: number, margin: number): Tile[] {
  if (!(width >= 1 && height >= 1 && core >= 1 && margin >= 0)) throw new RangeError('Invalid tile plan');
  const tiles: Tile[] = [];
  for (let y = 0; y < height; y += core) {
    for (let x = 0; x < width; x += core) {
      tiles.push({
        inputX: x - margin,
        inputY: y - margin,
        inputSize: core + 2 * margin,
        coreX: x,
        coreY: y,
        coreWidth: Math.min(core, width - x),
        coreHeight: Math.min(core, height - y),
      });
    }
  }
  return tiles;
}

const clampIndex = (value: number, max: number) => (value < 0 ? 0 : value > max ? max : value);

/**
 * Copy a tile out of an RGBA picture as the model's input: red, green and blue
 * planes one after another, each value 0 to 1. Where the tile reaches past the
 * picture, the nearest edge pixel is repeated.
 */
export function extractTile(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, tile: Tile): Float32Array {
  const size = tile.inputSize;
  const plane = size * size;
  const out = new Float32Array(3 * plane);
  for (let ty = 0; ty < size; ty++) {
    const sy = clampIndex(tile.inputY + ty, height - 1);
    for (let tx = 0; tx < size; tx++) {
      const sx = clampIndex(tile.inputX + tx, width - 1);
      const from = (sy * width + sx) * 4;
      const to = ty * size + tx;
      out[to] = rgba[from]! / 255;
      out[plane + to] = rgba[from + 1]! / 255;
      out[2 * plane + to] = rgba[from + 2]! / 255;
    }
  }
  return out;
}

/**
 * Write the core of a model result into the output picture.
 *
 * `result` is the model's output for the tile: three planes of side
 * `tile.inputSize * modelScale`. With `reduce` 2, each 2 x 2 block of the result
 * is averaged into one output pixel, which turns a 4x model into a 2x enlargement
 * without ever holding the 4x picture in memory. Alpha is set to opaque here.
 */
export function placeTile(
  out: Uint8ClampedArray,
  outWidth: number,
  tile: Tile,
  result: Float32Array,
  modelScale: number,
  reduce: 1 | 2 = 1,
): void {
  const side = tile.inputSize * modelScale;
  const plane = side * side;
  if (result.length < 3 * plane) throw new RangeError('The model returned a result of an unexpected size');
  const scale = modelScale / reduce;
  const margin = (tile.coreX - tile.inputX) * modelScale;
  const rows = tile.coreHeight * scale;
  const columns = tile.coreWidth * scale;
  const weight = 255 / (reduce * reduce);
  for (let y = 0; y < rows; y++) {
    const outRow = (tile.coreY * scale + y) * outWidth + tile.coreX * scale;
    for (let x = 0; x < columns; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < reduce; dy++) {
        const row = (margin + y * reduce + dy) * side + margin + x * reduce;
        for (let dx = 0; dx < reduce; dx++) {
          const at = row + dx;
          r += result[at]!;
          g += result[plane + at]!;
          b += result[2 * plane + at]!;
        }
      }
      const to = (outRow + x) * 4;
      // Model output is not limited to 0..1; a Uint8ClampedArray rounds and clamps.
      out[to] = r * weight;
      out[to + 1] = g * weight;
      out[to + 2] = b * weight;
      out[to + 3] = 255;
    }
  }
}
