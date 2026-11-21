import { FabricImage, Point, Rect, Shadow, Textbox, type FabricObject } from 'fabric';
import { frameCentre, localToPage, originFromCentre } from '../document/geometry';
import type { DesignNode, ImageNode, Shadow as ShadowSpec, TextNode } from '../document/types';
import type { DecodedImage } from './imageCache';

/**
 * Turns document nodes into Fabric objects and reads geometry back.
 *
 * The editor canvas and the exporter both build their objects here, which is what
 * keeps the export identical to what is on screen. Fabric is only a renderer:
 * nothing in this file is ever saved.
 */

/** Fabric 7 positions objects by their centre; we always say so explicitly. */
const CENTRE = 'center' as const;

/** Fabric multiplies text line height by this internal factor. */
function fontSizeMult(text: Textbox): number {
  return (text as unknown as { _fontSizeMult: number })._fontSizeMult || 1.13;
}

function toShadow(spec: ShadowSpec | null): Shadow | null {
  if (!spec) return null;
  // nonScaling keeps blur and offsets in page pixels whatever the object's own scale is.
  return new Shadow({ ...spec, nonScaling: true });
}

function placeByFrame(obj: FabricObject, origin: { x: number; y: number }, width: number, height: number, rotation: number) {
  const centre = frameCentre(origin, width, height, rotation);
  obj.set({ angle: rotation });
  obj.setPositionByOrigin(new Point(centre.x, centre.y), CENTRE, CENTRE);
  obj.setCoords();
}

// ------------------------------------------------------------------ images

export function applyImageNode(obj: FabricImage, node: ImageNode, source: DecodedImage): void {
  const s = source.scale;
  const cropWidth = node.crop.width * s;
  const cropHeight = node.crop.height * s;
  obj.set({
    cropX: node.crop.x * s,
    cropY: node.crop.y * s,
    width: cropWidth,
    height: cropHeight,
    scaleX: node.width / cropWidth,
    scaleY: node.height / cropHeight,
    flipX: node.flipX,
    flipY: node.flipY,
    opacity: node.opacity,
    visible: node.visible,
    shadow: toShadow(node.shadow),
    strokeWidth: 0,
  });
  placeByFrame(obj, node, node.width, node.height, node.rotation);
}

export function createImageObject(node: ImageNode, source: DecodedImage): FabricImage {
  const obj = new FabricImage(source.element, { objectCaching: false });
  applyImageNode(obj, node, source);
  return obj;
}

/** Stand-in for an image whose original cannot be found. Deliberately obvious. */
export function createMissingImageObject(node: ImageNode): Rect {
  const obj = new Rect({
    width: node.width,
    height: node.height,
    fill: 'rgba(255, 92, 92, 0.18)',
    stroke: '#ff5c5c',
    strokeWidth: 0,
    strokeDashArray: [12, 8],
    objectCaching: false,
  });
  applyMissingImageNode(obj, node);
  return obj;
}

export function applyMissingImageNode(obj: Rect, node: ImageNode): void {
  obj.set({ width: node.width, height: node.height, scaleX: 1, scaleY: 1, opacity: node.opacity, visible: node.visible });
  placeByFrame(obj, node, node.width, node.height, node.rotation);
}

// -------------------------------------------------------------------- text

export function applyTextNode(obj: Textbox, node: TextNode): void {
  const strokeWidth = node.outline ? node.outline.width : 0;
  obj.set({
    text: node.text,
    width: node.width,
    scaleX: 1,
    scaleY: 1,
    fontFamily: node.fontFamily,
    fontWeight: node.fontWeight,
    fontStyle: node.fontStyle,
    fontSize: node.fontSize,
    charSpacing: node.letterSpacing,
    textAlign: node.align,
    fill: node.fill,
    stroke: node.outline ? node.outline.color : null,
    strokeWidth,
    opacity: node.opacity,
    visible: node.visible,
    shadow: toShadow(node.shadow),
  });
  // The document's line height is a plain multiple of the font size.
  obj.set({ lineHeight: node.lineHeight / fontSizeMult(obj) });
  obj.initDimensions();
  placeTextObject(obj, node);
}

/**
 * Position a text object so the top-left of its text box sits at the node's (x, y).
 * Called again whenever the text's height changes, so the box grows downwards.
 */
export function placeTextObject(obj: Textbox, node: Pick<TextNode, 'x' | 'y' | 'rotation'>): void {
  const stroke = obj.strokeWidth || 0;
  // Fabric's bounding box includes the stroke; the document's text box does not.
  const boxOrigin = localToPage(node, node.rotation, { x: -stroke / 2, y: -stroke / 2 });
  placeByFrame(obj, boxOrigin, obj.width + stroke, obj.height + stroke, node.rotation);
}

export function createTextObject(node: TextNode): Textbox {
  const obj = new Textbox(node.text, {
    // Text is redrawn directly rather than from a cached bitmap, so it stays sharp at any zoom or export size.
    objectCaching: false,
    paintFirst: 'stroke',
    strokeLineJoin: 'round',
    lockScalingFlip: true,
    splitByGrapheme: false,
  });
  applyTextNode(obj, node);
  return obj;
}

/** The wrapped lines of a text object, exactly as drawn. */
export function textLines(obj: Textbox): string[] {
  return obj.textLines.slice();
}

// ---------------------------------------------------------- reading back

function normaliseAngle(angle: number): number {
  let a = angle % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return Math.abs(a) < 1e-9 ? 0 : a;
}

function r(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Read an object's on-canvas transform back into document terms, after the person
 * has moved, resized or rotated it.
 *
 * When several layers are transformed together Fabric keeps them inside a temporary
 * selection group; pass that group so its rotation and (uniform) scale are included.
 */
export function readNodeFromObject(obj: FabricObject, node: DesignNode, group?: FabricObject): DesignNode {
  const groupScaleX = group ? Math.abs(group.scaleX) : 1;
  const groupScaleY = group ? Math.abs(group.scaleY) : 1;
  const angle = normaliseAngle(obj.angle + (group ? group.angle : 0));
  const sx = Math.abs(obj.scaleX) * groupScaleX;
  const sy = Math.abs(obj.scaleY) * groupScaleY;
  // getCenterPoint already accounts for the group, if there is one.
  const centre = obj.getCenterPoint();

  if (node.type === 'image') {
    const width = obj.width * sx;
    const height = obj.height * sy;
    const origin = originFromCentre(centre, width, height, angle);
    // A negative scale is how Fabric expresses a flip after a group transform.
    const flipX = obj.flipX !== obj.scaleX < 0;
    const flipY = obj.flipY !== obj.scaleY < 0;
    return { ...node, x: r(origin.x), y: r(origin.y), width: r(width), height: r(height), rotation: r(angle), flipX, flipY };
  }

  const text = obj as Textbox;
  const scaled = Math.abs(sy - 1) > 1e-6 || Math.abs(sx - 1) > 1e-6;
  const stroke = text.strokeWidth || 0;
  const boxWidth = (text.width + stroke) * sx;
  const boxHeight = (text.height + stroke) * sy;
  const boxOrigin = originFromCentre(centre, boxWidth, boxHeight, angle);
  const origin = localToPage(boxOrigin, angle, { x: (stroke * sx) / 2, y: (stroke * sy) / 2 });
  const next: TextNode = { ...node, x: r(origin.x), y: r(origin.y), rotation: r(angle), width: r(text.width * sx) };
  if (scaled) {
    // Corner handles scale the type itself; side handles only change the box width.
    next.fontSize = r(node.fontSize * sy);
    if (node.outline) next.outline = { ...node.outline, width: r(node.outline.width * sy) };
    if (node.shadow) {
      next.shadow = {
        ...node.shadow,
        blur: r(node.shadow.blur * sy),
        offsetX: r(node.shadow.offsetX * sy),
        offsetY: r(node.shadow.offsetY * sy),
      };
    }
  }
  return next;
}
