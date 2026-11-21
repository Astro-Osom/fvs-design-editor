import type { AssetInfo, ImageNode, Rect } from './types';

export interface Point {
  x: number;
  y: number;
}

const DEG = Math.PI / 180;

/** Rotate a vector clockwise (in screen coordinates, y down) by `degrees`. */
export function rotateVector(v: Point, degrees: number): Point {
  const r = degrees * DEG;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos };
}

/** Page position of a point given in a node's local frame. */
export function localToPage(origin: Point, rotation: number, local: Point): Point {
  const r = rotateVector(local, rotation);
  return { x: origin.x + r.x, y: origin.y + r.y };
}

/** Local-frame position of a point given in page coordinates. */
export function pageToLocal(origin: Point, rotation: number, page: Point): Point {
  return rotateVector({ x: page.x - origin.x, y: page.y - origin.y }, -rotation);
}

/** Page position of the centre of a frame. */
export function frameCentre(origin: Point, width: number, height: number, rotation: number): Point {
  return localToPage(origin, rotation, { x: width / 2, y: height / 2 });
}

/** The frame's top-left corner, given its centre. */
export function originFromCentre(centre: Point, width: number, height: number, rotation: number): Point {
  const half = rotateVector({ x: width / 2, y: height / 2 }, rotation);
  return { x: centre.x - half.x, y: centre.y - half.y };
}

/** Display pixels per source pixel for an image node. */
export function imageScale(node: ImageNode): { sx: number; sy: number } {
  return { sx: node.width / node.crop.width, sy: node.height / node.crop.height };
}

/**
 * Where the WHOLE original image would sit, in the node's local frame, at the
 * node's current scale. The visible frame is [0, width] x [0, height]; this rect
 * usually extends beyond it. Used to draw and constrain the crop overlay.
 */
export function fullImageLocalRect(node: ImageNode, asset: Pick<AssetInfo, 'width' | 'height'>): Rect {
  const { sx, sy } = imageScale(node);
  const hiddenLeft = node.flipX ? asset.width - node.crop.x - node.crop.width : node.crop.x;
  const hiddenTop = node.flipY ? asset.height - node.crop.y - node.crop.height : node.crop.y;
  return {
    x: -hiddenLeft * sx,
    y: -hiddenTop * sy,
    width: asset.width * sx,
    height: asset.height * sy,
  };
}

/**
 * Re-crop an image node.
 *
 * `frame` is the wanted visible frame, expressed in the node's CURRENT local
 * coordinates (so `{x: 0, y: 0, width: node.width, height: node.height}` changes
 * nothing). The image itself does not move on the page: only the frame and the
 * crop rectangle change. The frame is clipped to the bounds of the original image.
 *
 * Returns null if the frame does not overlap the image.
 */
export function cropImageNode(
  node: ImageNode,
  asset: Pick<AssetInfo, 'width' | 'height'>,
  frame: Rect,
): ImageNode | null {
  const full = fullImageLocalRect(node, asset);
  const left = Math.max(frame.x, full.x);
  const top = Math.max(frame.y, full.y);
  const right = Math.min(frame.x + frame.width, full.x + full.width);
  const bottom = Math.min(frame.y + frame.height, full.y + full.height);
  const width = right - left;
  const height = bottom - top;
  if (!(width > 0.5) || !(height > 0.5)) return null;

  const { sx, sy } = imageScale(node);
  // Distance from the image's local left/top edge to the frame, in source pixels.
  const fromLeft = (left - full.x) / sx;
  const fromTop = (top - full.y) / sy;
  const cropWidth = width / sx;
  const cropHeight = height / sy;
  const crop: Rect = {
    x: node.flipX ? asset.width - fromLeft - cropWidth : fromLeft,
    y: node.flipY ? asset.height - fromTop - cropHeight : fromTop,
    width: cropWidth,
    height: cropHeight,
  };
  // Guard against floating-point drift outside the image.
  crop.x = Math.min(Math.max(0, crop.x), asset.width - crop.width);
  crop.y = Math.min(Math.max(0, crop.y), asset.height - crop.height);

  const origin = localToPage({ x: node.x, y: node.y }, node.rotation, { x: left, y: top });
  return { ...node, x: origin.x, y: origin.y, width, height, crop };
}

/** Round to a sensible precision for storage and display. */
export function round(value: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
