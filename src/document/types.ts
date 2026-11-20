/**
 * The application-owned document model.
 *
 * This is the source of truth for a design. The canvas library only renders it.
 * Everything here is plain JSON so it can be saved, diffed, migrated and tested
 * without a browser.
 *
 * Geometry convention (library independent):
 * - Units are page pixels.
 * - A node's local frame is the rectangle [0, width] x [0, height].
 * - (x, y) is where the frame's top-left corner sits on the page.
 * - `rotation` is clockwise degrees, applied about that top-left corner.
 *   In matrix terms: page = translate(x, y) * rotate(rotation) * local.
 */

export const SCHEMA_VERSION = 1;

export type NodeId = string;
export type AssetId = string;
export type PageId = string;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Shadow {
  color: string;
  blur: number;
  offsetX: number;
  offsetY: number;
}

export interface Outline {
  color: string;
  /** Total stroke width in page pixels. It is painted behind the fill, so half shows outside the glyphs. */
  width: number;
}

interface NodeBase {
  id: NodeId;
  name: string;
  x: number;
  y: number;
  /** Clockwise degrees about the frame's top-left corner. */
  rotation: number;
  /** 0 to 1. */
  opacity: number;
  visible: boolean;
  locked: boolean;
  shadow: Shadow | null;
}

export interface ImageNode extends NodeBase {
  type: 'image';
  assetId: AssetId;
  /** Size of the visible frame on the page. */
  width: number;
  height: number;
  /**
   * The part of the ORIGINAL image shown in the frame, in source-image pixels.
   * Cropping never changes the stored image; it only changes this rectangle.
   */
  crop: Rect;
  flipX: boolean;
  flipY: boolean;
}

export type TextAlign = 'left' | 'center' | 'right';

export interface TextNode extends NodeBase {
  type: 'text';
  text: string;
  /** Width of the text box. Height follows from the text layout. */
  width: number;
  fontFamily: string;
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
  fontSize: number;
  /** Multiple of the font size. */
  lineHeight: number;
  /** Extra space between characters, in thousandths of an em. */
  letterSpacing: number;
  align: TextAlign;
  fill: string;
  outline: Outline | null;
}

export type DesignNode = ImageNode | TextNode;

export interface Page {
  id: PageId;
  name: string;
  width: number;
  height: number;
  /** CSS colour, or null for a transparent page. */
  background: string | null;
  /** Bottom-most first. */
  nodes: DesignNode[];
}

export interface AssetInfo {
  /** SHA-256 of the original bytes, lowercase hex. This is the asset's durable identity. */
  id: AssetId;
  kind: 'image';
  mime: string;
  bytes: number;
  /** Pixel size after applying any EXIF orientation. */
  width: number;
  height: number;
  /** Original file name, for display only. */
  name: string;
}

export interface DesignDocument {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  name: string;
  createdAt: string;
  pages: Page[];
  /** Every original asset the document refers to. */
  assets: Record<AssetId, AssetInfo>;
}

/** A font the document uses, recorded in saved projects so missing fonts can be reported. */
export interface FontUse {
  family: string;
  weight: number;
  style: 'normal' | 'italic';
}
