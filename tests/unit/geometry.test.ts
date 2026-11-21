import { describe, expect, it } from 'vitest';
import {
  cropImageNode,
  frameCentre,
  fullImageLocalRect,
  localToPage,
  originFromCentre,
  pageToLocal,
} from '../../src/document/geometry';
import type { ImageNode } from '../../src/document/types';

const asset = { width: 2000, height: 1000 };

function imageNode(patch: Partial<ImageNode> = {}): ImageNode {
  return {
    id: 'image_1',
    type: 'image',
    name: 'Photo',
    assetId: 'a'.repeat(64),
    x: 100,
    y: 50,
    width: 1000,
    height: 500,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    shadow: null,
    crop: { x: 0, y: 0, width: 2000, height: 1000 },
    flipX: false,
    flipY: false,
    upscale: null,
    ...patch,
  };
}

describe('frame geometry', () => {
  it('converts between local and page coordinates, including rotation', () => {
    const origin = { x: 100, y: 50 };
    const p = localToPage(origin, 90, { x: 10, y: 0 });
    expect(p.x).toBeCloseTo(100);
    expect(p.y).toBeCloseTo(60);
    const back = pageToLocal(origin, 90, p);
    expect(back.x).toBeCloseTo(10);
    expect(back.y).toBeCloseTo(0);
  });

  it('round-trips a frame between its corner and its centre', () => {
    const origin = { x: 37, y: -12 };
    const centre = frameCentre(origin, 400, 250, 33);
    const again = originFromCentre(centre, 400, 250, 33);
    expect(again.x).toBeCloseTo(origin.x);
    expect(again.y).toBeCloseTo(origin.y);
  });
});

describe('nondestructive crop', () => {
  it('leaves the node alone when the frame is unchanged', () => {
    const node = imageNode();
    const result = cropImageNode(node, asset, { x: 0, y: 0, width: 1000, height: 500 })!;
    expect(result.crop).toEqual(node.crop);
    expect(result).toMatchObject({ x: 100, y: 50, width: 1000, height: 500 });
  });

  it('maps a smaller frame to source pixels without moving the image on the page', () => {
    // The node shows the 2000x1000 image at half scale. Keep the right half.
    const result = cropImageNode(imageNode(), asset, { x: 500, y: 0, width: 500, height: 500 })!;
    expect(result.crop).toEqual({ x: 1000, y: 0, width: 1000, height: 1000 });
    expect(result).toMatchObject({ x: 600, y: 50, width: 500, height: 500 });
  });

  it('can widen an existing crop back out to the original image', () => {
    const cropped = cropImageNode(imageNode(), asset, { x: 500, y: 100, width: 300, height: 200 })!;
    const full = fullImageLocalRect(cropped, asset);
    expect(full).toEqual({ x: -500, y: -100, width: 1000, height: 500 });
    const restored = cropImageNode(cropped, asset, full)!;
    expect(restored.crop).toEqual({ x: 0, y: 0, width: 2000, height: 1000 });
    expect(restored).toMatchObject({ x: 100, y: 50, width: 1000, height: 500 });
  });

  it('clips the frame to the edges of the original image', () => {
    const result = cropImageNode(imageNode(), asset, { x: -200, y: -200, width: 700, height: 400 })!;
    expect(result.crop).toEqual({ x: 0, y: 0, width: 1000, height: 400 });
    expect(result).toMatchObject({ x: 100, y: 50, width: 500, height: 200 });
  });

  it('returns null when the frame misses the image entirely', () => {
    expect(cropImageNode(imageNode(), asset, { x: 5000, y: 0, width: 100, height: 100 })).toBeNull();
  });

  it('accounts for a horizontal flip', () => {
    // Flipped, the left side of the frame shows the RIGHT side of the source.
    const node = imageNode({ flipX: true });
    const result = cropImageNode(node, asset, { x: 0, y: 0, width: 250, height: 500 })!;
    expect(result.crop).toEqual({ x: 1500, y: 0, width: 500, height: 1000 });
    expect(result).toMatchObject({ x: 100, y: 50, width: 250 });
    const full = fullImageLocalRect(result, asset);
    expect(full.x).toBeCloseTo(0);
    expect(full.width).toBeCloseTo(1000);
  });

  it('moves the frame origin along the rotated axes', () => {
    const node = imageNode({ rotation: 90 });
    const result = cropImageNode(node, asset, { x: 200, y: 0, width: 800, height: 500 })!;
    // Local +x points down the page when rotated 90 degrees clockwise.
    expect(result.x).toBeCloseTo(100);
    expect(result.y).toBeCloseTo(250);
    expect(result.rotation).toBe(90);
    expect(result.crop).toEqual({ x: 400, y: 0, width: 1600, height: 1000 });
  });
});
