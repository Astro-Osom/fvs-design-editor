import {
  ActiveSelection,
  Canvas,
  FabricImage,
  InteractiveFabricObject,
  Pattern,
  Point,
  Rect,
  Textbox,
  type FabricObject,
} from 'fabric';
import {
  cropImageNode,
  frameCentre,
  fullImageLocalRect,
  localToPage,
  originFromCentre,
  pageToLocal,
  round,
} from '../document/geometry';
import type { AssetId, DesignDocument, DesignNode, FontUse, ImageNode, NodeId, Page, Rect as RectSpec } from '../document/types';
import { loadFontsForDocument } from './fonts';
import type { DecodedImage, ImageCache } from './imageCache';
import {
  applyImageNode,
  applyMissingImageNode,
  applyTextNode,
  createImageObject,
  createMissingImageObject,
  createTextObject,
  placeTextObject,
  readNodeFromObject,
  textLines,
} from './nodeFactory';

/**
 * The interactive canvas.
 *
 * It draws the current document with Fabric and turns gestures into document
 * changes. It owns the viewport (zoom and pan) and the Fabric objects, and nothing
 * else: the document, selection and history live in the store and reach it through
 * `setDocument` and `select`. While something is being dragged only Fabric is
 * touched; the document changes once, when the gesture ends.
 */

export const ACCENT = '#5b9dff';

// One look for every selection box and handle.
InteractiveFabricObject.ownDefaults = {
  ...InteractiveFabricObject.ownDefaults,
  borderColor: ACCENT,
  borderScaleFactor: 1.5,
  cornerColor: '#ffffff',
  cornerStrokeColor: ACCENT,
  cornerStyle: 'circle',
  cornerSize: 11,
  touchCornerSize: 28,
  transparentCorners: false,
  padding: 0,
};

export interface EditorCanvasCallbacks {
  /** Replace these nodes in the document as ONE undo step. */
  onCommitNodes(nodes: DesignNode[], label: string): void;
  onRemoveNodes(ids: NodeId[], label: string): void;
  onSelectionChange(ids: NodeId[]): void;
  onEditingTextChange(editing: boolean): void;
  onZoomChange(zoom: number): void;
  /** The person double-clicked a photo. */
  onRequestCrop(id: NodeId): void;
  /** Crop mode ended (applied, cancelled, or forced closed). */
  onCropEnded(): void;
  onProblems(problems: { missingFonts: FontUse[]; missingAssets: AssetId[] }): void;
}

type EntryKind = 'image' | 'missing' | 'text';

interface Entry {
  obj: FabricObject;
  node: DesignNode;
  kind: EntryKind;
  source: DecodedImage | null;
}

interface CropSession {
  nodeId: NodeId;
  node: ImageNode;
  asset: { width: number; height: number };
  full: RectSpec;
  image: FabricImage;
  dim: Rect;
  hole: Rect;
  frame: Rect;
}

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 16;
const FIT_PADDING = 48;

function nodeIdOf(obj: FabricObject | undefined): NodeId | undefined {
  return (obj as { nodeId?: NodeId } | undefined)?.nodeId;
}

function place(obj: FabricObject, origin: { x: number; y: number }, width: number, height: number, rotation: number) {
  const centre = frameCentre(origin, width, height, rotation);
  obj.set({ angle: rotation });
  obj.setPositionByOrigin(new Point(centre.x, centre.y), 'center', 'center');
  obj.setCoords();
}

/**
 * A selection of several layers is resized in proportion only, so every layer in
 * it keeps its shape and its final size can be read back exactly.
 */
function configureGroup(selection: ActiveSelection): ActiveSelection {
  selection.setControlsVisibility({ ml: false, mr: false, mt: false, mb: false });
  selection.set({ lockScalingFlip: true });
  return selection;
}

function checkerboard(): Pattern {
  const tile = document.createElement('canvas');
  tile.width = 32;
  tile.height = 32;
  const g = tile.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 32, 32);
  g.fillStyle = '#d9dbe1';
  g.fillRect(0, 0, 16, 16);
  g.fillRect(16, 16, 16, 16);
  return new Pattern({ source: tile, repeat: 'repeat' });
}

export class EditorCanvas {
  readonly canvas: Canvas;
  private readonly entries = new Map<NodeId, Entry>();
  private readonly pageRect: Rect;
  private page: Page | null = null;
  private syncToken = 0;
  private wantedSelection: NodeId[] = [];
  private quiet = 0;
  private autoFit = true;
  private crop: CropSession | null = null;
  private spaceDown = false;
  private panFrom: { x: number; y: number } | null = null;
  private disposed = false;
  private readonly resizeObserver: ResizeObserver;
  private readonly root: HTMLDivElement;

  constructor(
    private readonly host: HTMLElement,
    private readonly images: ImageCache,
    private readonly callbacks: EditorCanvasCallbacks,
  ) {
    // Each controller draws inside its own element, so removing it leaves the host clean.
    this.root = document.createElement('div');
    this.root.style.cssText = 'position:absolute;inset:0';
    host.appendChild(this.root);
    const element = document.createElement('canvas');
    this.root.appendChild(element);
    this.canvas = new Canvas(element, {
      width: Math.max(1, host.clientWidth),
      height: Math.max(1, host.clientHeight),
      preserveObjectStacking: true,
      // Layers always resize in proportion. (Crop mode turns free reshaping on.)
      uniformScaling: true,
      uniScaleKey: null,
      selectionColor: 'rgba(91, 157, 255, 0.12)',
      selectionBorderColor: ACCENT,
      selectionLineWidth: 1,
      targetFindTolerance: 6,
    });
    this.pageRect = new Rect({
      strokeWidth: 0,
      selectable: false,
      evented: false,
      objectCaching: false,
      hoverCursor: 'default',
    });
    this.canvas.add(this.pageRect);
    this.bindCanvasEvents();
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onWindowBlur);
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(host);
  }

  dispose(): void {
    this.disposed = true;
    this.syncToken++;
    this.resizeObserver.disconnect();
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onWindowBlur);
    this.root.remove();
    void this.canvas.dispose();
  }

  // ------------------------------------------------------------ document

  /** Draw this document. Safe to call often; only what changed is touched. */
  async setDocument(doc: DesignDocument): Promise<void> {
    const token = ++this.syncToken;
    const page = doc.pages[0];
    if (!page) return;
    const assetIds = [...new Set(page.nodes.flatMap((n) => (n.type === 'image' ? [n.assetId] : [])))];
    const [missingFonts, decoded] = await Promise.all([
      loadFontsForDocument(doc),
      Promise.all(assetIds.map(async (id) => [id, await this.images.getPreview(id)] as const)),
    ]);
    if (token !== this.syncToken || this.disposed) return;
    const sources = new Map(decoded);
    this.reconcile(page, sources);
    this.callbacks.onProblems({
      missingFonts,
      missingAssets: assetIds.filter((id) => !sources.get(id)),
    });
  }

  private reconcile(page: Page, sources: Map<AssetId, DecodedImage | null>): void {
    const { canvas } = this;
    if (this.crop && !page.nodes.some((n) => n === this.crop!.node)) this.endCrop(false);

    // Children of a multi-selection are positioned relative to it, so let go of it
    // while their absolute positions are rewritten, then select again.
    const active = canvas.getActiveObject();
    if (active instanceof ActiveSelection) this.silently(() => canvas.discardActiveObject());

    this.updatePage(page);

    const seen = new Set<NodeId>();
    for (const node of page.nodes) {
      seen.add(node.id);
      const source = node.type === 'image' ? (sources.get(node.assetId) ?? null) : null;
      const kind: EntryKind = node.type === 'text' ? 'text' : source ? 'image' : 'missing';
      let entry = this.entries.get(node.id);
      if (entry && (entry.kind !== kind || entry.source !== source)) {
        this.silently(() => canvas.remove(entry!.obj));
        this.entries.delete(node.id);
        entry = undefined;
      }
      if (!entry) {
        const obj =
          node.type === 'text'
            ? createTextObject(node)
            : source
              ? createImageObject(node, source)
              : createMissingImageObject(node);
        (obj as { nodeId?: NodeId }).nodeId = node.id;
        if (node.type === 'image') {
          // Photos keep their proportions; the shape of the frame is changed by cropping.
          obj.setControlsVisibility({ ml: false, mr: false, mt: false, mb: false });
        } else {
          // Text height follows from its content.
          obj.setControlsVisibility({ mt: false, mb: false });
        }
        canvas.add(obj);
        entry = { obj, node, kind, source };
        this.entries.set(node.id, entry);
      } else if (entry.node !== node) {
        const editing = entry.obj instanceof Textbox && entry.obj.isEditing;
        if (!editing) this.applyNode(entry, node);
        entry.node = node;
      }
      this.applyInteractivity(entry.obj, node);
    }
    for (const [id, entry] of this.entries) {
      if (seen.has(id)) continue;
      canvas.remove(entry.obj);
      this.entries.delete(id);
    }
    // Stacking order: the page first, then layers bottom to top.
    page.nodes.forEach((node, index) => {
      const obj = this.entries.get(node.id)!.obj;
      if (canvas.item(index + 1) !== obj) canvas.moveObjectTo(obj, index + 1);
    });

    this.applySelection();
    canvas.requestRenderAll();
  }

  private applyNode(entry: Entry, node: DesignNode): void {
    if (node.type === 'text') applyTextNode(entry.obj as Textbox, node);
    else if (entry.kind === 'image' && entry.source) applyImageNode(entry.obj as FabricImage, node, entry.source);
    else applyMissingImageNode(entry.obj as Rect, node);
  }

  private applyInteractivity(obj: FabricObject, node: DesignNode): void {
    const usable = !node.locked && !this.crop;
    obj.set({
      selectable: usable,
      evented: usable,
      hasControls: usable,
      lockMovementX: !usable,
      lockMovementY: !usable,
      hoverCursor: usable ? 'move' : 'default',
    });
  }

  private updatePage(page: Page): void {
    const previous = this.page;
    this.page = page;
    const sizeChanged = !previous || previous.width !== page.width || previous.height !== page.height;
    if (previous && !sizeChanged && previous.background === page.background) return;
    this.pageRect.set({
      width: page.width,
      height: page.height,
      fill: page.background ?? checkerboard(),
    });
    place(this.pageRect, { x: 0, y: 0 }, page.width, page.height, 0);
    this.setPageClip(true);
    if (sizeChanged && this.autoFit) this.fitPage();
  }

  /** Layers are clipped to the page while editing, so the canvas shows what export will produce. */
  private setPageClip(on: boolean): void {
    if (!on || !this.page) {
      this.canvas.clipPath = undefined;
      return;
    }
    const clip = new Rect({ width: this.page.width, height: this.page.height, strokeWidth: 0 });
    place(clip, { x: 0, y: 0 }, this.page.width, this.page.height, 0);
    this.canvas.clipPath = clip;
  }

  // ----------------------------------------------------------- selection

  /** Make the canvas selection match these layer ids. */
  select(ids: NodeId[]): void {
    this.wantedSelection = ids;
    if (this.crop) return;
    this.applySelection();
    this.canvas.requestRenderAll();
  }

  private currentSelectionIds(): NodeId[] {
    return this.canvas
      .getActiveObjects()
      .map(nodeIdOf)
      .filter((id): id is NodeId => !!id);
  }

  private applySelection(): void {
    if (this.crop) return;
    const { canvas } = this;
    const wanted = this.wantedSelection.filter((id) => this.entries.has(id));
    const current = this.currentSelectionIds();
    if (wanted.length === current.length && wanted.every((id) => current.includes(id))) return;
    const editing = canvas.getActiveObject();
    if (editing instanceof Textbox && editing.isEditing) return;
    this.silently(() => {
      canvas.discardActiveObject();
      const objects = wanted.map((id) => this.entries.get(id)!.obj);
      if (objects.length === 1) canvas.setActiveObject(objects[0]!);
      else if (objects.length > 1) canvas.setActiveObject(configureGroup(new ActiveSelection(objects, { canvas })));
    });
  }

  private silently(fn: () => void): void {
    this.quiet++;
    try {
      fn();
    } finally {
      this.quiet--;
    }
  }

  // -------------------------------------------------------------- events

  private bindCanvasEvents(): void {
    const { canvas } = this;

    const selectionChanged = () => {
      const active = canvas.getActiveObject();
      if (active instanceof ActiveSelection) configureGroup(active);
      if (this.quiet) return;
      if (this.crop) {
        // In crop mode the crop frame stays selected until the crop is applied or cancelled.
        if (canvas.getActiveObject() !== this.crop.frame) {
          this.silently(() => canvas.setActiveObject(this.crop!.frame));
          canvas.requestRenderAll();
        }
        return;
      }
      const ids = this.currentSelectionIds();
      this.wantedSelection = ids;
      this.callbacks.onSelectionChange(ids);
    };
    canvas.on('selection:created', selectionChanged);
    canvas.on('selection:updated', selectionChanged);
    canvas.on('selection:cleared', selectionChanged);

    canvas.on('object:modified', (event) => {
      if (this.crop) return;
      const target = event.target;
      // Fabric also fires this when a typing session ends. That change is recorded by
      // the text handlers below; only real move, resize and rotate gestures belong here.
      if (!target || !event.transform) return;
      const action = event.transform.action ?? event.action ?? '';
      const verb = action === 'drag' ? 'Move' : action === 'rotate' ? 'Rotate' : 'Resize';
      // Several layers moved together sit inside Fabric's temporary selection group.
      // Their final positions are read through that group; the selection itself is
      // left alone here, because changing it from inside this event would re-enter it.
      const group = target instanceof ActiveSelection ? target : undefined;
      const objects = group ? group.getObjects() : [target];
      const nodes: DesignNode[] = [];
      for (const obj of objects) {
        const id = nodeIdOf(obj);
        const entry = id ? this.entries.get(id) : undefined;
        if (entry) nodes.push(readNodeFromObject(obj, entry.node, group));
      }
      if (nodes.length) {
        this.callbacks.onCommitNodes(nodes, `${verb} ${nodes.length > 1 ? `${nodes.length} layers` : 'layer'}`);
      }
    });

    canvas.on('text:editing:entered', () => this.callbacks.onEditingTextChange(true));
    canvas.on('text:changed', (event) => {
      const target = event.target as Textbox | undefined;
      const entry = this.entries.get(nodeIdOf(target) ?? '');
      // Keep the top of the box where it is while lines are added or removed.
      if (target && entry?.node.type === 'text') placeTextObject(target, entry.node);
    });
    canvas.on('text:editing:exited', (event) => {
      this.callbacks.onEditingTextChange(false);
      const target = event.target as Textbox | undefined;
      const entry = this.entries.get(nodeIdOf(target) ?? '');
      if (!target || !entry || entry.node.type !== 'text') return;
      const node = entry.node;
      const text = target.text;
      // One editing session is one undo step, however many keys were pressed.
      if (text.trim() === '') {
        this.callbacks.onRemoveNodes([node.id], 'Delete empty text');
      } else if (text !== node.text || Math.abs(target.width - node.width) > 0.01) {
        this.callbacks.onCommitNodes([{ ...node, text, width: round(target.width) }], 'Edit text');
      }
    });

    canvas.on('mouse:dblclick', (event) => {
      if (this.crop) return;
      const entry = this.entries.get(nodeIdOf(event.target) ?? '');
      if (entry?.kind === 'image' && !entry.node.locked) this.callbacks.onRequestCrop(entry.node.id);
    });

    canvas.on('mouse:wheel', (event) => {
      const e = event.e;
      e.preventDefault();
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey) {
        // Pinch on a trackpad, or Ctrl/Cmd + wheel: zoom around the pointer.
        const factor = Math.exp(-e.deltaY * 0.01);
        this.zoomAt(canvas.getViewportPoint(e), canvas.getZoom() * factor);
      } else {
        this.autoFit = false;
        canvas.relativePan(new Point(-e.deltaX, -e.deltaY));
        canvas.requestRenderAll();
        this.viewportChanged();
      }
    });

    canvas.on('mouse:down', (event) => {
      const e = event.e as MouseEvent;
      if (this.spaceDown || e.button === 1) {
        this.panFrom = { x: e.clientX, y: e.clientY };
        canvas.setCursor('grabbing');
      }
    });
    canvas.on('mouse:move', (event) => {
      if (!this.panFrom) return;
      const e = event.e as MouseEvent;
      this.autoFit = false;
      canvas.relativePan(new Point(e.clientX - this.panFrom.x, e.clientY - this.panFrom.y));
      this.panFrom = { x: e.clientX, y: e.clientY };
      canvas.setCursor('grabbing');
      this.viewportChanged();
    });
    canvas.on('mouse:up', () => {
      if (!this.panFrom) return;
      this.panFrom = null;
      canvas.setCursor(this.spaceDown ? 'grab' : 'default');
    });
  }

  private isTyping(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
  }

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (e.code !== 'Space' || this.spaceDown || this.isTyping(e.target)) return;
    // Hold Space and drag to move around the canvas.
    this.spaceDown = true;
    this.canvas.skipTargetFind = true;
    this.canvas.selection = false;
    this.canvas.defaultCursor = 'grab';
    this.canvas.setCursor('grab');
    e.preventDefault();
  };

  private readonly onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'Space') this.releaseSpace();
  };

  private readonly onWindowBlur = () => this.releaseSpace();

  private releaseSpace(): void {
    if (!this.spaceDown) return;
    this.spaceDown = false;
    this.panFrom = null;
    this.canvas.skipTargetFind = false;
    this.canvas.selection = !this.crop;
    this.canvas.defaultCursor = 'default';
    this.canvas.setCursor('default');
  }

  // ------------------------------------------------------------ viewport

  getZoom(): number {
    return this.canvas.getZoom();
  }

  private handleResize(): void {
    if (this.disposed) return;
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    if (width === this.canvas.getWidth() && height === this.canvas.getHeight()) return;
    this.canvas.setDimensions({ width, height });
    if (this.autoFit) this.fitPage();
    else this.canvas.requestRenderAll();
  }

  /** Show the whole page, centred. */
  fitPage(): void {
    if (!this.page) return;
    const width = this.canvas.getWidth();
    const height = this.canvas.getHeight();
    const zoom = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, Math.min((width - FIT_PADDING * 2) / this.page.width, (height - FIT_PADDING * 2) / this.page.height)),
    );
    this.autoFit = true;
    this.setViewport(zoom, (width - this.page.width * zoom) / 2, (height - this.page.height * zoom) / 2);
  }

  /** 100%: one page pixel is one screen pixel. */
  actualSize(): void {
    if (!this.page) return;
    const width = this.canvas.getWidth();
    const height = this.canvas.getHeight();
    this.autoFit = false;
    this.setViewport(1, (width - this.page.width) / 2, (height - this.page.height) / 2);
  }

  zoomBy(factor: number): void {
    this.zoomAt(new Point(this.canvas.getWidth() / 2, this.canvas.getHeight() / 2), this.canvas.getZoom() * factor);
  }

  private zoomAt(point: Point, zoom: number): void {
    this.autoFit = false;
    this.canvas.zoomToPoint(point, Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)));
    this.canvas.requestRenderAll();
    this.viewportChanged();
  }

  private setViewport(zoom: number, panX: number, panY: number): void {
    this.canvas.setViewportTransform([zoom, 0, 0, zoom, panX, panY]);
    this.canvas.requestRenderAll();
    this.viewportChanged();
  }

  /** Publish the viewport: the zoom readout uses it, and so do automated tests. */
  private viewportChanged(): void {
    const [zoom, , , , panX, panY] = this.canvas.viewportTransform;
    this.host.dataset.zoom = String(zoom);
    this.host.dataset.panX = String(panX);
    this.host.dataset.panY = String(panY);
    this.callbacks.onZoomChange(zoom);
  }

  // ---------------------------------------------------------------- text

  /** Start typing in a text layer. */
  editText(id: NodeId): void {
    const entry = this.entries.get(id);
    if (!entry || !(entry.obj instanceof Textbox) || entry.node.locked) return;
    this.canvas.setActiveObject(entry.obj);
    entry.obj.enterEditing();
    entry.obj.selectAll();
    this.canvas.requestRenderAll();
  }

  isEditingText(): boolean {
    const active = this.canvas.getActiveObject();
    return active instanceof Textbox && !!active.isEditing;
  }

  /** Finish typing and keep the text. */
  finishTextEditing(): void {
    const active = this.canvas.getActiveObject();
    if (active instanceof Textbox && active.isEditing) active.exitEditing();
  }

  /** Wrapped lines of every text layer as currently drawn. */
  getTextLayout(): Record<NodeId, string[]> {
    const layout: Record<NodeId, string[]> = {};
    for (const [id, entry] of this.entries) {
      if (entry.obj instanceof Textbox) layout[id] = textLines(entry.obj);
    }
    return layout;
  }

  // ---------------------------------------------------------------- crop

  isCropping(): boolean {
    return !!this.crop;
  }

  /**
   * Enter crop mode for a photo. The whole original is shown dimmed, with a frame
   * over the part that is kept. Moving or resizing the frame never moves the photo.
   * Nothing changes in the document until `applyCrop`.
   */
  enterCrop(id: NodeId): boolean {
    if (this.crop) this.endCrop(false);
    const entry = this.entries.get(id);
    if (!entry || entry.kind !== 'image' || entry.node.type !== 'image' || !entry.source || entry.node.locked) return false;
    const { canvas } = this;
    const node = entry.node;
    const source = entry.source;
    const asset = { width: source.sourceWidth, height: source.sourceHeight };
    const full = fullImageLocalRect(node, asset);
    const fullOrigin = localToPage(node, node.rotation, full);

    this.silently(() => canvas.discardActiveObject());

    const image = new FabricImage(source.element, {
      objectCaching: false,
      selectable: false,
      evented: false,
      flipX: node.flipX,
      flipY: node.flipY,
      strokeWidth: 0,
      scaleX: full.width / source.element.width,
      scaleY: full.height / source.element.height,
    });
    place(image, fullOrigin, full.width, full.height, node.rotation);

    const hole = new Rect({ width: node.width, height: node.height, strokeWidth: 0, absolutePositioned: true, inverted: true });
    place(hole, node, node.width, node.height, node.rotation);

    const dim = new Rect({
      width: full.width,
      height: full.height,
      fill: 'rgba(12, 13, 16, 0.66)',
      strokeWidth: 0,
      selectable: false,
      evented: false,
      clipPath: hole,
    });
    place(dim, fullOrigin, full.width, full.height, node.rotation);

    const frame = new Rect({
      width: node.width,
      height: node.height,
      fill: 'rgba(0, 0, 0, 0)',
      strokeWidth: 0,
      objectCaching: false,
      lockRotation: true,
      lockScalingFlip: true,
      borderColor: '#ffffff',
      cornerStrokeColor: '#1d1e22',
      hoverCursor: 'move',
    });
    frame.setControlsVisibility({ mtr: false });
    place(frame, node, node.width, node.height, node.rotation);

    this.crop = { nodeId: id, node, asset, full, image, dim, hole, frame };
    entry.obj.set({ visible: false });
    for (const other of this.entries.values()) this.applyInteractivity(other.obj, other.node);
    this.setPageClip(false);
    canvas.selection = false;
    // Corner handles reshape the crop freely; hold Shift to keep its proportions.
    canvas.uniformScaling = false;
    canvas.uniScaleKey = 'shiftKey';

    frame.on('moving', () => this.constrainCropFrame('move'));
    frame.on('scaling', () => this.constrainCropFrame('scale'));
    canvas.add(image, dim, frame);
    this.silently(() => canvas.setActiveObject(frame));
    canvas.requestRenderAll();
    return true;
  }

  /** The crop frame in the photo's own local coordinates. */
  private cropFrameLocal(): RectSpec {
    const { node, frame } = this.crop!;
    const width = frame.width * Math.abs(frame.scaleX);
    const height = frame.height * Math.abs(frame.scaleY);
    const origin = pageToLocal(node, node.rotation, originFromCentre(frame.getCenterPoint(), width, height, node.rotation));
    return { x: origin.x, y: origin.y, width, height };
  }

  private constrainCropFrame(mode: 'move' | 'scale'): void {
    const session = this.crop;
    if (!session) return;
    const { node, frame, full, hole, dim } = session;
    const local = this.cropFrameLocal();
    let left = local.x;
    let top = local.y;
    let right = local.x + local.width;
    let bottom = local.y + local.height;
    const fullRight = full.x + full.width;
    const fullBottom = full.y + full.height;
    if (mode === 'move') {
      // Slide the frame back inside the photo without changing its size.
      const width = Math.min(local.width, full.width);
      const height = Math.min(local.height, full.height);
      left = Math.min(Math.max(left, full.x), fullRight - width);
      top = Math.min(Math.max(top, full.y), fullBottom - height);
      right = left + width;
      bottom = top + height;
    } else {
      // Stop each edge at the edge of the photo.
      left = Math.max(left, full.x);
      top = Math.max(top, full.y);
      right = Math.min(right, fullRight);
      bottom = Math.min(bottom, fullBottom);
    }
    const width = Math.max(8, right - left);
    const height = Math.max(8, bottom - top);
    const changed =
      Math.abs(left - local.x) > 1e-6 ||
      Math.abs(top - local.y) > 1e-6 ||
      Math.abs(width - local.width) > 1e-6 ||
      Math.abs(height - local.height) > 1e-6;
    const origin = localToPage(node, node.rotation, { x: left, y: top });
    if (changed) {
      frame.set({ scaleX: width / frame.width, scaleY: height / frame.height });
      place(frame, origin, width, height, node.rotation);
    }
    hole.set({ width, height });
    place(hole, origin, width, height, node.rotation);
    dim.set('dirty', true);
  }

  /** Keep the chosen frame. One undo step. */
  applyCrop(): void {
    const session = this.crop;
    if (!session) return;
    const next = cropImageNode(session.node, session.asset, this.cropFrameLocal());
    this.endCrop(true);
    if (!next) return;
    const rounded: ImageNode = {
      ...next,
      x: round(next.x),
      y: round(next.y),
      width: round(next.width),
      height: round(next.height),
      crop: {
        x: round(next.crop.x),
        y: round(next.crop.y),
        width: round(next.crop.width),
        height: round(next.crop.height),
      },
    };
    this.callbacks.onCommitNodes([rounded], 'Crop photo');
  }

  /** Leave crop mode and change nothing. */
  cancelCrop(): void {
    if (this.crop) this.endCrop(true);
  }

  private endCrop(reselect: boolean): void {
    const session = this.crop;
    if (!session) return;
    const { canvas } = this;
    this.crop = null;
    this.silently(() => {
      canvas.discardActiveObject();
      canvas.remove(session.image, session.dim, session.frame);
    });
    canvas.selection = true;
    canvas.uniformScaling = true;
    canvas.uniScaleKey = null;
    this.setPageClip(true);
    for (const entry of this.entries.values()) {
      entry.obj.set({ visible: entry.node.visible });
      this.applyInteractivity(entry.obj, entry.node);
    }
    if (reselect) this.wantedSelection = [session.nodeId];
    this.applySelection();
    canvas.requestRenderAll();
    this.callbacks.onCropEnded();
  }
}
