import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MemoryAssetStore, sha256Hex } from '../../src/assets/assetStore';
import {
  addAsset,
  addNode,
  createDocument,
  findDerivedAsset,
  firstPage,
  imageSourceId,
  imageStretch,
  makeImageNode,
  pruneUnusedAssets,
  setImageUpscale,
  usedAssetIds,
} from '../../src/document/ops';
import { parseDocument } from '../../src/document/schema';
import { SCHEMA_VERSION, type AssetInfo, type DesignDocument, type ImageNode } from '../../src/document/types';
import { packProject, unpackProject } from '../../src/storage/projectFile';
import { MAX_UPSCALED_EDGE, upscaleFits } from '../../src/upscale/engine';
import { downloadModel, ModelError, REAL_ESRGAN_GENERAL, storedModel, upscaleModel, type UpscaleModel } from '../../src/upscale/model';
import { hasTransparency, resample, resampleAlphaInto } from '../../src/upscale/resample';
import { extractTile, placeTile, planTiles, type Tile } from '../../src/upscale/tiles';

const here = path.dirname(fileURLToPath(import.meta.url));

/** A small picture with a different value in every channel of every pixel. */
function picture(width: number, height: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      rgba[at] = (x * 37 + y * 11) % 256;
      rgba[at + 1] = (x * 5 + y * 71) % 256;
      rgba[at + 2] = (x * 13 + y * 29 + 100) % 256;
      rgba[at + 3] = 255;
    }
  }
  return rgba;
}

/** Stand-ins for a model: take a tile (three planes, side `size`) and return it `scale` times larger. */
function nearestModel(input: Float32Array, size: number, scale: number): Float32Array {
  const side = size * scale;
  const out = new Float32Array(3 * side * side);
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) out[c * side * side + y * side + x] = input[c * size * size + Math.floor(y / scale) * size + Math.floor(x / scale)]!;
    }
  }
  return out;
}

/** A model that looks at each pixel's neighbours (a 3 x 3 average) before enlarging, like a real one does. */
function blurModel(input: Float32Array, size: number, scale: number): Float32Array {
  const blurred = new Float32Array(input.length);
  const at = (c: number, x: number, y: number) => input[c * size * size + Math.min(size - 1, Math.max(0, y)) * size + Math.min(size - 1, Math.max(0, x))]!;
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += at(c, x + dx, y + dy);
        blurred[c * size * size + y * size + x] = sum / 9;
      }
    }
  }
  return nearestModel(blurred, size, scale);
}

type Model = (input: Float32Array, size: number, scale: number) => Float32Array;

function enlargeInTiles(rgba: Uint8ClampedArray, width: number, height: number, model: Model, options: { core: number; margin: number; scale: number; reduce?: 1 | 2 }) {
  const factor = options.scale / (options.reduce ?? 1);
  const out = new Uint8ClampedArray(width * factor * height * factor * 4);
  const tiles = planTiles(width, height, options.core, options.margin);
  for (const tile of tiles) {
    placeTile(out, width * factor, tile, model(extractTile(rgba, width, height, tile), tile.inputSize, options.scale), options.scale, options.reduce ?? 1);
  }
  return { out, tiles, width: width * factor, height: height * factor };
}

describe('enlarging in tiles', () => {
  it('cuts a picture into equal squares whose middles cover every pixel exactly once', () => {
    for (const [width, height, core, margin] of [
      [1280, 720, 224, 16],
      [100, 37, 32, 8],
      [5, 5, 96, 16],
      [224, 224, 224, 16],
      [225, 449, 224, 16],
    ] as const) {
      const tiles = planTiles(width, height, core, margin);
      expect(tiles).toHaveLength(Math.ceil(width / core) * Math.ceil(height / core));
      const covered = new Uint8Array(width * height);
      for (const tile of tiles) {
        // Every tile given to the model is the same size, so the model never has to adapt.
        expect(tile.inputSize).toBe(core + 2 * margin);
        expect(tile.inputX).toBe(tile.coreX - margin);
        expect(tile.inputY).toBe(tile.coreY - margin);
        for (let y = tile.coreY; y < tile.coreY + tile.coreHeight; y++) {
          for (let x = tile.coreX; x < tile.coreX + tile.coreWidth; x++) covered[y * width + x]!++;
        }
      }
      expect(covered.every((count) => count === 1)).toBe(true);
    }
    expect(planTiles(1280, 720, 224, 16)).toHaveLength(24);
    expect(() => planTiles(0, 10, 32, 4)).toThrow(RangeError);
  });

  it('gives the model edge pixels repeated where a tile reaches past the picture', () => {
    const rgba = picture(4, 3);
    const tile: Tile = { inputX: -2, inputY: -1, inputSize: 8, coreX: 0, coreY: 0, coreWidth: 4, coreHeight: 3 };
    const input = extractTile(rgba, 4, 3, tile);
    expect(input).toHaveLength(3 * 8 * 8);
    const red = (x: number, y: number) => Math.round(input[y * 8 + x]! * 255);
    // Top-left of the tile is outside the picture: it repeats pixel (0, 0).
    expect(red(0, 0)).toBe(rgba[0]);
    expect(red(2, 1)).toBe(rgba[0]);
    // Inside the picture the values are the picture's own, scaled to 0..1.
    expect(red(3, 2)).toBe(rgba[(1 * 4 + 1) * 4]);
    // Far right and bottom repeat the last column and row.
    expect(red(7, 7)).toBe(rgba[(2 * 4 + 3) * 4]);
    // Green and blue follow in their own planes.
    expect(Math.round(input[64 + 2 * 8 + 3]! * 255)).toBe(rgba[(1 * 4 + 1) * 4 + 1]);
    expect(Math.round(input[128 + 2 * 8 + 3]! * 255)).toBe(rgba[(1 * 4 + 1) * 4 + 2]);
  });

  it('stitches tiles into exactly what the model would give for the whole picture', () => {
    const width = 53;
    const height = 31;
    const rgba = picture(width, height);
    const whole = enlargeInTiles(rgba, width, height, blurModel, { core: 64, margin: 0, scale: 4 });
    expect(whole.tiles).toHaveLength(1);
    // Many small tiles with a margin at least as wide as what the model looks at: no seams at all.
    const tiled = enlargeInTiles(rgba, width, height, blurModel, { core: 8, margin: 2, scale: 4 });
    expect(tiled.tiles.length).toBeGreaterThan(20);
    expect(Buffer.from(tiled.out).equals(Buffer.from(whole.out))).toBe(true);
    // With no margin the model is blind at tile edges and the result differs: the margin is what prevents seams.
    const seamed = enlargeInTiles(rgba, width, height, blurModel, { core: 8, margin: 0, scale: 4 });
    expect(Buffer.from(seamed.out).equals(Buffer.from(whole.out))).toBe(false);
  });

  it('enlarges 4 times, or 2 times by averaging, with every output pixel written and opaque', () => {
    const width = 19;
    const height = 11;
    const rgba = picture(width, height);
    const four = enlargeInTiles(rgba, width, height, nearestModel, { core: 8, margin: 3, scale: 4 });
    expect([four.width, four.height]).toEqual([76, 44]);
    const two = enlargeInTiles(rgba, width, height, nearestModel, { core: 8, margin: 3, scale: 4, reduce: 2 });
    expect([two.width, two.height]).toEqual([38, 22]);
    for (const { out, width: w, height: h } of [four, two]) {
      const factor = w / width;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const from = (Math.floor(y / factor) * width + Math.floor(x / factor)) * 4;
          const to = (y * w + x) * 4;
          expect([out[to], out[to + 1], out[to + 2], out[to + 3]]).toEqual([rgba[from], rgba[from + 1], rgba[from + 2], 255]);
        }
      }
    }
  });

  it('keeps model output that strays outside the valid range within it', () => {
    const tile = planTiles(2, 1, 2, 0)[0]!;
    const out = new Uint8ClampedArray(2 * 1 * 4);
    // red: -0.2 and 1.4; green: 0.5 and 0.25; blue: 1 and 0
    placeTile(out, 2, tile, new Float32Array([-0.2, 1.4, 9, 9, 0.5, 0.25, 9, 9, 1, 0, 9, 9]), 1);
    expect(Array.from(out)).toEqual([0, 128, 255, 255, 255, 64, 0, 255]);
    expect(() => placeTile(out, 2, tile, new Float32Array(3), 1)).toThrow(/unexpected size/);
  });
});

describe('plain resize', () => {
  it('keeps flat colour flat, returns the right size and changes nothing at the same size', () => {
    const flat = new Uint8ClampedArray(6 * 4 * 4).fill(200);
    const bigger = resample(flat, 6, 4, 4, 24, 16);
    expect(bigger).toHaveLength(24 * 16 * 4);
    expect(bigger.every((value) => value === 200)).toBe(true);
    const rgba = picture(9, 7);
    expect(Array.from(resample(rgba, 9, 7, 4, 9, 7))).toEqual(Array.from(rgba));
    expect(() => resample(rgba, 9, 7, 4, 0, 7)).toThrow(RangeError);
  });

  it('enlarges an edge smoothly without inventing new extremes far from it', () => {
    // Left half black, right half white.
    const width = 8;
    const source = new Uint8ClampedArray(width * 1);
    for (let x = 4; x < width; x++) source[x] = 255;
    const out = resample(source, width, 1, 1, 32, 1);
    expect(out[0]).toBe(0);
    expect(out[31]).toBe(255);
    // It rises from dark to light across the middle.
    expect(out[12]!).toBeLessThan(out[16]!);
    expect(out[16]!).toBeLessThan(out[19]!);
    // The straight-line filter used for transparency never overshoots: it only ever rises.
    const plain = resample(source, width, 1, 1, 32, 1, 'linear');
    for (let x = 1; x < 32; x++) expect(plain[x]!).toBeGreaterThanOrEqual(plain[x - 1]!);
    expect([plain[0], plain[31]]).toEqual([0, 255]);
  });

  it('carries transparency through an enlargement', () => {
    const rgba = picture(4, 4);
    expect(hasTransparency(rgba)).toBe(false);
    for (let i = 0; i < 8; i++) rgba[i * 4 + 3] = 0; // top half see-through
    expect(hasTransparency(rgba)).toBe(true);
    const target = new Uint8ClampedArray(16 * 16 * 4).fill(255);
    resampleAlphaInto(rgba, 4, 4, target, 16, 16);
    // Fully see-through stays fully see-through, and solid stays solid: no halo.
    for (let x = 0; x < 16; x++) expect(target[x * 4 + 3]).toBe(0);
    for (let x = 0; x < 16; x++) expect(target[(15 * 16 + x) * 4 + 3]).toBe(255);
    // In between it blends.
    const middle = target[(8 * 16 + 8) * 4 + 3]!;
    expect(middle).toBeGreaterThan(0);
    expect(middle).toBeLessThan(255);
    // Colour is left alone.
    expect(target[0]).toBe(255);
  });

  it('refuses enlargements that would be too large to make reliably', () => {
    expect(upscaleFits(1280, 720, 4)).toBe(true);
    expect(upscaleFits(1920, 1080, 4)).toBe(true);
    expect(upscaleFits(4000, 3000, 2)).toBe(false);
    expect(upscaleFits(4000, 3000, 4)).toBe(false);
    expect(upscaleFits(MAX_UPSCALED_EDGE / 2 + 1, 10, 2)).toBe(false);
  });
});

describe('upscaling in the document', () => {
  const original: AssetInfo = { id: 'a'.repeat(64), kind: 'image', mime: 'image/jpeg', bytes: 1000, width: 1280, height: 720, name: 'beach.jpg' };
  const derived = (factor: number, method: 'realesr-general-x4v3' | 'resample' = 'realesr-general-x4v3', id = `${factor}`.repeat(64)): AssetInfo => ({
    id,
    kind: 'image',
    mime: 'image/png',
    bytes: 5000,
    width: original.width * factor,
    height: original.height * factor,
    name: `beach (enlarged ${factor}x).png`,
    derivedFrom: { assetId: original.id, method, factor },
  });

  function design(): { doc: DesignDocument; node: ImageNode } {
    let doc = createDocument({ width: 1280, height: 720 });
    doc = addAsset(doc, original);
    const node = { ...makeImageNode(original, firstPage(doc)), x: 0, y: 0, width: 1280, height: 720 };
    return { doc: addNode(doc, node), node };
  }

  it('keeps the original and only records which enlarged copy to draw from', () => {
    const { doc, node } = design();
    expect(node.upscale).toBeNull();
    expect(imageSourceId(node)).toBe(original.id);

    const up = setImageUpscale(doc, node.id, derived(4));
    const upNode = firstPage(up).nodes[0] as ImageNode;
    expect(upNode.upscale).toEqual({ assetId: '4'.repeat(64), method: 'realesr-general-x4v3', factor: 4 });
    // Everything else about the layer is untouched: same original, same crop, same frame.
    expect({ ...upNode, upscale: null }).toEqual(node);
    expect(imageSourceId(upNode)).toBe('4'.repeat(64));
    expect(up.assets[original.id]).toEqual(original);
    expect(up.assets['4'.repeat(64)]).toEqual(derived(4));
    expect(doc.assets['4'.repeat(64)]).toBeUndefined();
    expect(parseDocument(up).doc).toEqual(up);

    // Turning it off gives the original layer back exactly.
    const off = setImageUpscale(up, node.id, null);
    expect(firstPage(off).nodes[0]).toEqual(node);
    // Asking for what is already there changes nothing, so no empty undo step is made.
    expect(setImageUpscale(up, node.id, derived(4))).toBe(up);
    expect(setImageUpscale(doc, node.id, null)).toBe(doc);
  });

  it('refuses an enlarged copy of a different photo', () => {
    const { doc, node } = design();
    const other: AssetInfo = { ...derived(2), derivedFrom: { assetId: 'f'.repeat(64), method: 'resample', factor: 2 } };
    expect(setImageUpscale(doc, node.id, other)).toBe(doc);
    expect(setImageUpscale(doc, node.id, { ...original })).toBe(doc);
    expect(setImageUpscale(doc, 'no_such_layer', derived(2))).toBe(doc);
    // A document that points at an enlarged copy it does not list is damaged.
    const broken = { ...doc, pages: [{ ...firstPage(doc), nodes: [{ ...node, upscale: { assetId: 'e'.repeat(64), method: 'resample', factor: 2 } }] }] };
    expect(() => parseDocument(broken)).toThrow(/not listed/);
  });

  it('finds an enlarged copy by what it was made from and how, so the same work is not done twice', () => {
    const { doc, node } = design();
    const up = setImageUpscale(doc, node.id, derived(4));
    expect(findDerivedAsset(up, original.id, 'realesr-general-x4v3', 4)).toEqual(derived(4));
    expect(findDerivedAsset(up, original.id, 'realesr-general-x4v3', 2)).toBeUndefined();
    expect(findDerivedAsset(up, original.id, 'resample', 4)).toBeUndefined();
    expect(findDerivedAsset(up, 'f'.repeat(64), 'realesr-general-x4v3', 4)).toBeUndefined();
    expect(findDerivedAsset(doc, original.id, 'realesr-general-x4v3', 4)).toBeUndefined();
  });

  it('measures how far a photo is stretched, counting its enlarged copy', () => {
    const { doc, node } = design();
    // 1280 pixels of photo across 1280 pixels of page.
    expect(imageStretch(node)).toBe(100);
    // The same page exported at 3840 wide.
    expect(imageStretch(node, 3)).toBe(300);
    const up = firstPage(setImageUpscale(doc, node.id, derived(2))).nodes[0] as ImageNode;
    expect(imageStretch(up, 3)).toBe(150);
    expect(imageStretch(firstPage(setImageUpscale(doc, node.id, derived(4))).nodes[0] as ImageNode, 3)).toBe(75);
    // Cropping to half the width doubles the stretch of what is left.
    expect(imageStretch({ ...node, crop: { x: 0, y: 0, width: 640, height: 720 } })).toBe(200);
  });

  it('keeps the enlarged copy in the project while it is used, and drops it once it is turned off', async () => {
    const { doc, node } = design();
    const up = setImageUpscale(doc, node.id, derived(4));
    expect([...usedAssetIds(up)].sort()).toEqual(['4'.repeat(64), original.id].sort());
    expect(pruneUnusedAssets(up)).toBe(up);
    const off = setImageUpscale(up, node.id, null);
    // The record lingers in the open design (so undo is instant) but is not written to a project file.
    expect(off.assets['4'.repeat(64)]).toBeDefined();
    expect(Object.keys(pruneUnusedAssets(off).assets)).toEqual([original.id]);

    // In a project file: both the original and the enlarged copy travel, each under its own hash.
    const store = new MemoryAssetStore();
    const originalBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const enlargedBytes = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1]);
    const originalId = await sha256Hex(originalBytes);
    const enlargedId = await sha256Hex(enlargedBytes);
    await store.put({ id: originalId, mime: 'image/jpeg', bytes: originalBytes });
    await store.put({ id: enlargedId, mime: 'image/png', bytes: enlargedBytes });
    let real = createDocument({ width: 1280, height: 720 });
    real = addAsset(real, { ...original, id: originalId });
    const layer = makeImageNode({ ...original, id: originalId }, firstPage(real));
    real = setImageUpscale(addNode(real, layer), layer.id, { ...derived(4, 'realesr-general-x4v3', enlargedId), derivedFrom: { assetId: originalId, method: 'realesr-general-x4v3', factor: 4 } });
    const opened = await unpackProject((await packProject({ doc: real, getAsset: (id) => store.get(id), appVersion: '0.1.0' })).bytes);
    expect(opened.doc).toEqual(real);
    expect(opened.assets.map((asset) => asset.id).sort()).toEqual([originalId, enlargedId].sort());
    expect(opened.missingAssets).toEqual([]);
  });

  it('upgrades a format 2 document: photos gain an empty upscale record and nothing else changes', () => {
    const v2 = JSON.parse(readFileSync(path.join(here, '..', 'fixtures', 'document-v2.json'), 'utf8'));
    const { doc, migratedFrom } = parseDocument(v2);
    expect(migratedFrom).toBe(2);
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
    const [photo, text] = firstPage(doc).nodes;
    expect(photo).toEqual({ ...v2.pages[0].nodes[0], upscale: null });
    expect(text).toEqual(v2.pages[0].nodes[1]);
    expect('upscale' in text!).toBe(false);
    expect(doc.fonts).toEqual(v2.fonts);
    expect(doc.assets).toEqual(v2.assets);
    expect(v2.schemaVersion).toBe(2);
    // A format 1 document goes through both upgrades.
    const v1 = JSON.parse(readFileSync(path.join(here, '..', 'fixtures', 'document-v1.json'), 'utf8'));
    const upgraded = parseDocument(v1);
    expect(upgraded.migratedFrom).toBe(1);
    expect((firstPage(upgraded.doc).nodes[0] as ImageNode).upscale).toBeNull();
    expect(upgraded.doc.fonts).toEqual([]);
  });
});

describe('the enlarging model', () => {
  const stub = new Uint8Array(readFileSync(path.join(here, '..', 'fixtures', 'nearest-x4-stub.onnx')));
  const other = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

  async function model(): Promise<UpscaleModel> {
    return {
      ...REAL_ESRGAN_GENERAL,
      sources: [
        { url: 'https://example.test/first.onnx', bytes: stub.length, sha256: await sha256Hex(stub) },
        { url: 'https://example.test/second.onnx', bytes: other.length, sha256: await sha256Hex(other) },
      ],
    };
  }
  const answering = (table: Record<string, () => Response>, log: string[] = []): typeof fetch =>
    (async (input: RequestInfo | URL) => {
      log.push(String(input));
      const answer = table[String(input)];
      if (!answer) throw new TypeError('Failed to fetch');
      return answer();
    }) as typeof fetch;

  it('pins exact, reviewed files and never lets tests download the real one by accident', () => {
    for (const source of REAL_ESRGAN_GENERAL.sources) {
      // Pinned to a full commit, on Hugging Face, with a size and a SHA-256.
      expect(source.url).toMatch(/^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+\/resolve\/[0-9a-f]{40}\/.+\.onnx$/);
      expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(source.bytes).toBeGreaterThan(4_000_000);
    }
    expect(REAL_ESRGAN_GENERAL.license).toBe('BSD-3-Clause');
    expect(upscaleModel()).toBe(REAL_ESRGAN_GENERAL);
    const scope = globalThis as { __FVS_TEST_UPSCALE_SOURCES__?: unknown };
    scope.__FVS_TEST_UPSCALE_SOURCES__ = [{ url: 'https://example.test/stub.onnx', bytes: 316, sha256: 'a'.repeat(64) }];
    expect(upscaleModel().sources).toEqual([{ url: 'https://example.test/stub.onnx', bytes: 316, sha256: 'a'.repeat(64) }]);
    delete scope.__FVS_TEST_UPSCALE_SOURCES__;
  });

  it('downloads once, checks the file against its hash, and keeps it for next time', async () => {
    const m = await model();
    expect(await storedModel(m)).toBeNull();
    const log: string[] = [];
    const progress: number[] = [];
    const bytes = await downloadModel(
      { fetch: answering({ 'https://example.test/first.onnx': () => new Response(stub as BodyInit) }, log), onProgress: (received, total) => progress.push(received / total) },
      m,
    );
    expect(Array.from(bytes)).toEqual(Array.from(stub));
    expect(log).toEqual(['https://example.test/first.onnx']);
    expect(progress.at(-1)).toBe(1);
    expect(Array.from((await storedModel(m))!)).toEqual(Array.from(stub));
    // A stored file that no longer matches any reviewed file is not used.
    expect(await storedModel({ ...m, sources: [{ url: 'x', bytes: 1, sha256: 'f'.repeat(64) }] })).toBeNull();
  });

  it('falls back to the second address, and never runs a file that does not match', async () => {
    const m = await model();
    // First address serves something else entirely; the second serves the right file.
    const log: string[] = [];
    const fromSecond = await downloadModel(
      { fetch: answering({ 'https://example.test/first.onnx': () => new Response('<html>not a model</html>'), 'https://example.test/second.onnx': () => new Response(other as BodyInit) }, log) },
      m,
    );
    expect(Array.from(fromSecond)).toEqual(Array.from(other));
    expect(log).toEqual(['https://example.test/first.onnx', 'https://example.test/second.onnx']);

    const wrong = await downloadModel(
      { fetch: answering({ 'https://example.test/first.onnx': () => new Response('tampered'), 'https://example.test/second.onnx': () => new Response('also tampered') }) },
      m,
    ).catch((error: unknown) => error);
    expect(wrong).toBeInstanceOf(ModelError);
    expect((wrong as ModelError).code).toBe('bad-response');
    expect((wrong as ModelError).message).toMatch(/did not match/);

    const offline = await downloadModel({ fetch: answering({}) }, m).catch((error: unknown) => error);
    expect((offline as ModelError).code).toBe('offline');
    expect((offline as ModelError).message).toMatch(/internet connection/);

    const missing = await downloadModel({ fetch: answering({ 'https://example.test/first.onnx': () => new Response('gone', { status: 404 }) }) }, m).catch((error: unknown) => error);
    expect((missing as ModelError).code).toBe('bad-response');

    const controller = new AbortController();
    controller.abort();
    const cancelled = await downloadModel({ fetch: answering({}), signal: controller.signal }, m).catch((error: unknown) => error);
    expect((cancelled as ModelError).code).toBe('cancelled');
  });
});
