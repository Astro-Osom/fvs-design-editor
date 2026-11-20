import {
  SCHEMA_VERSION,
  type AssetId,
  type AssetInfo,
  type DesignDocument,
  type DesignNode,
  type DocumentFont,
  type FontUse,
  type FontUseRecord,
  type ImageNode,
  type NodeId,
  type Page,
  type TextNode,
} from './types';

/**
 * Pure operations on documents. Every function returns a new document and leaves
 * its input untouched, so each result can be kept as an undo step.
 */

export type NodePatch = Partial<Omit<ImageNode, 'id' | 'type'>> & Partial<Omit<TextNode, 'id' | 'type'>>;

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export interface NewDocumentOptions {
  name?: string;
  width: number;
  height: number;
  background?: string | null;
}

export function createDocument(options: NewDocumentOptions): DesignDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newId('doc'),
    name: options.name?.trim() || 'Untitled design',
    createdAt: new Date().toISOString(),
    pages: [
      {
        id: newId('page'),
        name: 'Page 1',
        width: options.width,
        height: options.height,
        background: options.background === undefined ? '#ffffff' : options.background,
        nodes: [],
      },
    ],
    assets: {},
    fonts: [],
  };
}

/** The slice edits a single page; the model already allows more. */
export function firstPage(doc: DesignDocument): Page {
  const page = doc.pages[0];
  if (!page) throw new Error('Document has no pages');
  return page;
}

export function findNode(doc: DesignDocument, id: NodeId): { node: DesignNode; page: Page; index: number } | null {
  for (const page of doc.pages) {
    const index = page.nodes.findIndex((n) => n.id === id);
    if (index >= 0) return { node: page.nodes[index]!, page, index };
  }
  return null;
}

function mapPage(doc: DesignDocument, pageId: string, fn: (page: Page) => Page): DesignDocument {
  let changed = false;
  const pages = doc.pages.map((page) => {
    if (page.id !== pageId) return page;
    const next = fn(page);
    if (next !== page) changed = true;
    return next;
  });
  return changed ? { ...doc, pages } : doc;
}

export function renameDocument(doc: DesignDocument, name: string): DesignDocument {
  const trimmed = name.trim() || 'Untitled design';
  return trimmed === doc.name ? doc : { ...doc, name: trimmed };
}

export function updatePage(
  doc: DesignDocument,
  pageId: string,
  patch: Partial<Pick<Page, 'name' | 'width' | 'height' | 'background'>>,
): DesignDocument {
  return mapPage(doc, pageId, (page) => ({ ...page, ...patch }));
}

export function addAsset(doc: DesignDocument, asset: AssetInfo): DesignDocument {
  if (doc.assets[asset.id]) return doc;
  return { ...doc, assets: { ...doc.assets, [asset.id]: asset } };
}

/** Add a node on top of the page's existing nodes. */
export function addNode(doc: DesignDocument, node: DesignNode, pageId: string = firstPage(doc).id): DesignDocument {
  return mapPage(doc, pageId, (page) => ({ ...page, nodes: [...page.nodes, node] }));
}

export function updateNodes(doc: DesignDocument, patches: Record<NodeId, NodePatch>): DesignDocument {
  let changed = false;
  const pages = doc.pages.map((page) => {
    let pageChanged = false;
    const nodes = page.nodes.map((node) => {
      const patch = patches[node.id];
      if (!patch) return node;
      const next = { ...node, ...patch } as DesignNode;
      const same = (Object.keys(patch) as (keyof DesignNode)[]).every((k) => Object.is(node[k], next[k]));
      if (same) return node;
      pageChanged = true;
      return next;
    });
    if (!pageChanged) return page;
    changed = true;
    return { ...page, nodes };
  });
  return changed ? { ...doc, pages } : doc;
}

export function updateNode(doc: DesignDocument, id: NodeId, patch: NodePatch): DesignDocument {
  return updateNodes(doc, { [id]: patch });
}

/** Swap a node for a new version of itself (same id). */
export function replaceNode(doc: DesignDocument, node: DesignNode): DesignDocument {
  const found = findNode(doc, node.id);
  if (!found) return doc;
  return mapPage(doc, found.page.id, (page) => ({
    ...page,
    nodes: page.nodes.map((n) => (n.id === node.id ? node : n)),
  }));
}

export function removeNodes(doc: DesignDocument, ids: readonly NodeId[]): DesignDocument {
  const drop = new Set(ids);
  let changed = false;
  const pages = doc.pages.map((page) => {
    const nodes = page.nodes.filter((n) => !drop.has(n.id));
    if (nodes.length === page.nodes.length) return page;
    changed = true;
    return { ...page, nodes };
  });
  return changed ? { ...doc, pages } : doc;
}

export type StackMove = 'forward' | 'backward' | 'front' | 'back';

export function moveNodeToIndex(doc: DesignDocument, id: NodeId, index: number): DesignDocument {
  const found = findNode(doc, id);
  if (!found) return doc;
  const target = Math.max(0, Math.min(found.page.nodes.length - 1, index));
  if (target === found.index) return doc;
  return mapPage(doc, found.page.id, (page) => {
    const nodes = page.nodes.slice();
    const [node] = nodes.splice(found.index, 1);
    nodes.splice(target, 0, node!);
    return { ...page, nodes };
  });
}

export function shiftNode(doc: DesignDocument, id: NodeId, move: StackMove): DesignDocument {
  const found = findNode(doc, id);
  if (!found) return doc;
  const last = found.page.nodes.length - 1;
  const target =
    move === 'front' ? last : move === 'back' ? 0 : move === 'forward' ? found.index + 1 : found.index - 1;
  return moveNodeToIndex(doc, id, target);
}

/** Copy nodes, placing each copy directly above its original. Returns the new ids in order. */
export function duplicateNodes(
  doc: DesignDocument,
  ids: readonly NodeId[],
  offset = { x: 24, y: 24 },
): { doc: DesignDocument; ids: NodeId[] } {
  const wanted = new Set(ids);
  const created: NodeId[] = [];
  let changed = false;
  const pages = doc.pages.map((page) => {
    if (!page.nodes.some((n) => wanted.has(n.id))) return page;
    changed = true;
    const nodes: DesignNode[] = [];
    for (const node of page.nodes) {
      nodes.push(node);
      if (wanted.has(node.id)) {
        const copy = { ...node, id: newId(node.type), x: node.x + offset.x, y: node.y + offset.y } as DesignNode;
        created.push(copy.id);
        nodes.push(copy);
      }
    }
    return { ...page, nodes };
  });
  return { doc: changed ? { ...doc, pages } : doc, ids: created };
}

/** Insert already-built nodes (for example from the clipboard) on top of a page. */
export function insertNodes(
  doc: DesignDocument,
  nodes: readonly DesignNode[],
  assets: readonly AssetInfo[] = [],
  fonts: readonly DocumentFont[] = [],
  pageId: string = firstPage(doc).id,
): DesignDocument {
  let next = doc;
  for (const asset of assets) next = addAsset(next, asset);
  // A family the design already lists keeps its own pinned files.
  const added = fonts.filter((font) => !documentFont(next, font.family));
  if (added.length) next = { ...next, fonts: [...next.fonts, ...added] };
  return mapPage(next, pageId, (page) => ({ ...page, nodes: [...page.nodes, ...nodes] }));
}

export function usedAssetIds(doc: DesignDocument): Set<AssetId> {
  const used = new Set<AssetId>();
  for (const page of doc.pages) {
    for (const node of page.nodes) if (node.type === 'image') used.add(node.assetId);
  }
  return used;
}

/** Drop asset records nothing refers to. Used when writing a project file. */
export function pruneUnusedAssets(doc: DesignDocument): DesignDocument {
  const used = usedAssetIds(doc);
  const entries = Object.entries(doc.assets).filter(([id]) => used.has(id));
  if (entries.length === Object.keys(doc.assets).length) return doc;
  return { ...doc, assets: Object.fromEntries(entries) };
}

export function fontsUsed(doc: DesignDocument): FontUse[] {
  const seen = new Map<string, FontUse>();
  for (const page of doc.pages) {
    for (const node of page.nodes) {
      if (node.type !== 'text') continue;
      const key = `${node.fontFamily}|${node.fontWeight}|${node.fontStyle}`;
      if (!seen.has(key)) seen.set(key, { family: node.fontFamily, weight: node.fontWeight, style: node.fontStyle });
    }
  }
  return [...seen.values()];
}

// ------------------------------------------------------------------- fonts

/** The design's own record for a family, or undefined when the family is one of the built-in fonts. */
export function documentFont(doc: DesignDocument, family: string): DocumentFont | undefined {
  return doc.fonts.find((font) => font.family === family);
}

/** Add a font to the design, or replace the design's record for that family. */
export function setDocumentFont(doc: DesignDocument, font: DocumentFont): DesignDocument {
  const index = doc.fonts.findIndex((f) => f.family === font.family);
  if (index >= 0 && doc.fonts[index] === font) return doc;
  const fonts = doc.fonts.slice();
  if (index >= 0) fonts[index] = font;
  else fonts.push(font);
  return { ...doc, fonts };
}

/** Drop font records no text uses. */
export function pruneUnusedFonts(doc: DesignDocument): DesignDocument {
  const used = new Set(fontsUsed(doc).map((use) => use.family));
  const fonts = doc.fonts.filter((font) => used.has(font.family));
  return fonts.length === doc.fonts.length ? doc : { ...doc, fonts };
}

export type FaceKey = Pick<FontUse, 'weight' | 'style'>;

/**
 * The face a family really has that is closest to the one asked for. The same
 * style (upright or italic) is preferred; weight is matched as closely as possible.
 */
export function nearestFace(faces: readonly FaceKey[], weight: number, style: FontUse['style']): FaceKey | null {
  const sameStyle = faces.filter((face) => face.style === style);
  const pool = sameStyle.length ? sameStyle : faces;
  let best: FaceKey | null = null;
  for (const face of pool) {
    if (!best || Math.abs(face.weight - weight) < Math.abs(best.weight - weight)) best = face;
  }
  return best ? { weight: best.weight, style: best.style } : null;
}

/**
 * Change the font family of some text layers, as one change.
 *
 * `faces` are the styles the family really has: each layer moves to the nearest
 * one, so a weight or italic that does not exist is never asked for. `font` is
 * the record to keep with the design, or null for a built-in family.
 */
export function setTextFont(
  doc: DesignDocument,
  ids: readonly NodeId[],
  family: string,
  faces: readonly FaceKey[],
  font: DocumentFont | null,
): DesignDocument {
  const patches: Record<NodeId, NodePatch> = {};
  for (const id of ids) {
    const found = findNode(doc, id);
    if (!found || found.node.type !== 'text') continue;
    const face = nearestFace(faces, found.node.fontWeight, found.node.fontStyle);
    patches[id] = { fontFamily: family, fontWeight: face?.weight ?? found.node.fontWeight, fontStyle: face?.style ?? found.node.fontStyle };
  }
  let next = updateNodes(doc, patches);
  if (font) next = setDocumentFont(next, font);
  else if (documentFont(next, family)) next = { ...next, fonts: next.fonts.filter((f) => f.family !== family) };
  return pruneUnusedFonts(next);
}

/** Every face in use, with where it comes from. Written into a saved project's manifest. */
export function fontUseRecords(doc: DesignDocument): FontUseRecord[] {
  return fontsUsed(doc).map((use) => {
    const font = documentFont(doc, use.family);
    if (!font) return { ...use, source: 'bundled', embedded: false };
    const face = font.faces.find((f) => f.weight === use.weight && f.style === use.style);
    const record: FontUseRecord = { ...use, source: font.source, embedded: font.embed && !!face && face.files.length > 0 };
    if (font.license) record.license = font.license;
    return record;
  });
}

/** A new image layer showing the whole image, fitted inside the page and centred. */
export function makeImageNode(asset: AssetInfo, page: Pick<Page, 'width' | 'height'>): ImageNode {
  const fit = Math.min(1, (page.width * 0.9) / asset.width, (page.height * 0.9) / asset.height);
  const width = asset.width * fit;
  const height = asset.height * fit;
  return {
    id: newId('image'),
    type: 'image',
    name: asset.name.replace(/\.[a-z0-9]+$/i, '') || 'Photo',
    assetId: asset.id,
    x: (page.width - width) / 2,
    y: (page.height - height) / 2,
    width,
    height,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    shadow: null,
    crop: { x: 0, y: 0, width: asset.width, height: asset.height },
    flipX: false,
    flipY: false,
  };
}

export type TextPreset = 'heading' | 'subheading' | 'body' | 'headline';

export const TEXT_PRESET_LABELS: Record<TextPreset, string> = {
  headline: 'Thumbnail headline',
  heading: 'Heading',
  subheading: 'Subheading',
  body: 'Body text',
};

/** A new text layer sized relative to the page, so presets look right at any page size. */
export function makeTextNode(page: Pick<Page, 'width' | 'height'>, preset: TextPreset): TextNode {
  const unit = page.height;
  const styles: Record<TextPreset, Partial<TextNode> & { fontSize: number; text: string }> = {
    headline: {
      text: 'BIG TITLE',
      fontFamily: 'Anton',
      fontWeight: 400,
      fontSize: unit * 0.2,
      fill: '#ffffff',
      outline: { color: '#000000', width: Math.round(unit * 0.03) },
      lineHeight: 1.05,
    },
    heading: { text: 'Add a heading', fontFamily: 'Montserrat', fontWeight: 800, fontSize: unit * 0.12 },
    subheading: { text: 'Add a subheading', fontFamily: 'Montserrat', fontWeight: 600, fontSize: unit * 0.07 },
    body: { text: 'Add a little body text', fontFamily: 'Inter', fontWeight: 400, fontSize: unit * 0.04 },
  };
  const style = styles[preset];
  const width = page.width * 0.7;
  const fontSize = Math.round(style.fontSize);
  return {
    id: newId('text'),
    type: 'text',
    name: '',
    x: (page.width - width) / 2,
    y: page.height / 2 - fontSize * 0.6,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    shadow: null,
    width,
    fontFamily: 'Inter',
    fontWeight: 400,
    fontStyle: 'normal',
    lineHeight: 1.15,
    letterSpacing: 0,
    align: 'center',
    fill: '#111111',
    outline: null,
    ...style,
    fontSize,
  };
}

/** What a layer is called in the Layers panel. Text layers default to their content. */
export function nodeLabel(node: DesignNode): string {
  if (node.name.trim()) return node.name;
  if (node.type === 'text') return node.text.replace(/\s+/g, ' ').trim().slice(0, 40) || 'Empty text';
  return 'Photo';
}

/** Scale a node's position, size and effects about the page origin. */
export function scaleNode<T extends DesignNode>(node: T, factor: number): T {
  const shadow = node.shadow
    ? { ...node.shadow, blur: node.shadow.blur * factor, offsetX: node.shadow.offsetX * factor, offsetY: node.shadow.offsetY * factor }
    : null;
  if (node.type === 'image') {
    return { ...node, x: node.x * factor, y: node.y * factor, width: node.width * factor, height: node.height * factor, shadow };
  }
  return {
    ...node,
    x: node.x * factor,
    y: node.y * factor,
    width: node.width * factor,
    fontSize: node.fontSize * factor,
    outline: node.outline ? { ...node.outline, width: node.outline.width * factor } : null,
    shadow,
  };
}

/**
 * Change the page size. When the new size has the same proportions (for example
 * 1280 × 720 to 3840 × 2160) everything on the page is scaled with it, so the
 * design looks the same at the new size. Otherwise layers keep their size and position.
 */
export function resizePage(doc: DesignDocument, pageId: string, width: number, height: number): DesignDocument {
  return mapPage(doc, pageId, (page) => {
    if (page.width === width && page.height === height) return page;
    const sameShape = Math.abs(width / height - page.width / page.height) < 0.005;
    const factor = width / page.width;
    return {
      ...page,
      width,
      height,
      nodes: sameShape ? page.nodes.map((node) => scaleNode(node, factor)) : page.nodes,
    };
  });
}
