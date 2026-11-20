import { sha256Hex } from '../assets/assetStore';
import {
  addAsset,
  addNode,
  createDocument,
  documentFont,
  duplicateNodes,
  findNode,
  firstPage,
  insertNodes,
  makeImageNode,
  makeTextNode,
  newId,
  removeNodes,
  renameDocument,
  replaceNode,
  resizePage,
  shiftNode,
  updateNodes,
  updatePage,
  type NodePatch,
  type StackMove,
  type TextPreset,
} from '../document/ops';
import { parseDocument } from '../document/schema';
import type { AssetInfo, DesignDocument, DesignNode, DocumentFont, NodeId } from '../document/types';
import { openProjectFile, pickFiles, platformKind, saveExportFile, saveProjectFile } from '../platform/files';
import { exportPage, type ExportOptions, type ExportResult } from '../render/exportPage';
import { decodeImage, SUPPORTED_IMAGE_TYPES } from '../render/imageCache';
import { isQuotaError } from '../storage/idb';
import { packProject, projectFileName, unpackProject } from '../storage/projectFile';
import { getProject } from '../storage/projectsDb';
import { claimProject, flushAutosave, noteSavedToFile, releaseProject, resetAutosave } from './autosave';
import { APP_VERSION, assets, editorRef, fonts, images } from './services';
import {
  closeDocumentInStore,
  commitDoc,
  commitDocLive,
  currentDoc,
  openDocumentInStore,
  redo as redoInStore,
  selectDoc,
  setSelection,
  showToast,
  store,
  undo as undoInStore,
  type ProjectFile,
} from './store';

/** Everything the interface can ask the editor to do. */

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function apply(label: string, change: (doc: DesignDocument) => DesignDocument): boolean {
  return commitDoc(change(currentDoc()), label);
}

function leaveModes(): void {
  editorRef.current?.finishTextEditing();
  editorRef.current?.cancelCrop();
}

// ---------------------------------------------------------------- projects

export function newProject(size: { width: number; height: number }): void {
  const doc = createDocument({ width: size.width, height: size.height });
  resetAutosave();
  images.clear();
  openDocumentInStore(doc, { label: 'New design' });
  claimProject(doc.id);
}

export async function loadProjectBytes(bytes: Uint8Array, file: ProjectFile): Promise<boolean> {
  try {
    const opened = await unpackProject(bytes);
    for (const asset of opened.assets) {
      if (!(await assets.has(asset.id))) await assets.put(asset);
    }
    for (const file of opened.fontFiles) {
      if (!(await fonts.hasFile(file.id))) await fonts.putFile(file);
    }
    await rememberOpenFonts(opened.doc);
    const problems = [...opened.missingAssets, ...opened.corruptAssets];
    resetAutosave(opened.manifest.savedAt ?? null);
    images.clear();
    openDocumentInStore(opened.doc, {
      label: 'Open project',
      file,
      saved: true,
      warnings: { missingAssets: problems },
    });
    claimProject(opened.doc.id);
    if (opened.migratedFrom !== null) {
      showToast('info', 'This project was made with an older version and has been updated. Save it to keep the update.');
    }
    return true;
  } catch (error) {
    showToast('error', isQuotaError(error) ? 'Browser storage is full, so this project could not be opened.' : messageOf(error));
    return false;
  }
}

/**
 * Openly licensed fonts that arrive inside a project become available to other
 * designs on this machine too, as if they had been downloaded here.
 */
async function rememberOpenFonts(doc: DesignDocument): Promise<void> {
  for (const font of doc.fonts) {
    if (font.source !== 'google' || (await fonts.getFamily(font.family))) continue;
    const present = await Promise.all(font.files.map((file) => fonts.hasFile(file.id)));
    if (!present.every(Boolean)) continue;
    await fonts.putFamily({
      family: font.family,
      source: 'google',
      ...(font.license ? { license: font.license } : {}),
      embeddable: true,
      files: font.files,
      faces: font.faces,
      addedAt: new Date().toISOString(),
    });
  }
}

export async function openProjectFromPicker(): Promise<boolean> {
  try {
    const opened = await openProjectFile();
    if (!opened) return false;
    return await loadProjectBytes(opened.bytes, opened.file);
  } catch (error) {
    showToast('error', `The file could not be opened. ${messageOf(error)}`);
    return false;
  }
}

/** Reopen a project from browser storage (the recent-projects list). */
export async function openRecentProject(id: string): Promise<boolean> {
  try {
    const stored = await getProject(id);
    if (!stored) {
      showToast('error', 'That project is no longer in this browser.');
      return false;
    }
    const { doc } = parseDocument(stored.doc);
    const missing: string[] = [];
    for (const assetId of Object.keys(doc.assets)) {
      if (!(await assets.has(assetId))) missing.push(assetId);
    }
    resetAutosave(stored.savedToFileAt);
    images.clear();
    // A recovered project has no file attached: saving asks where to put it.
    openDocumentInStore(doc, { label: 'Open project', saved: false, warnings: { missingAssets: missing } });
    claimProject(doc.id);
    return true;
  } catch (error) {
    showToast('error', messageOf(error));
    return false;
  }
}

export async function closeProject(): Promise<void> {
  leaveModes();
  await flushAutosave();
  releaseProject();
  resetAutosave();
  images.clear();
  closeDocumentInStore();
}

export async function saveProject(saveAs = false): Promise<boolean> {
  leaveModes();
  const state = store.getState();
  const doc = selectDoc(state);
  if (!doc) return false;
  store.setState({ busy: 'Saving…' });
  try {
    const packed = await packProject({
      doc,
      getAsset: (id) => assets.get(id),
      getFontFile: (id) => fonts.getFile(id),
      appVersion: APP_VERSION,
    });
    const file = await saveProjectFile(packed.bytes, projectFileName(doc.name), state.file, saveAs);
    if (!file) return false;
    noteSavedToFile();
    store.setState({ file, savedDoc: doc });
    if (packed.missingAssets.length) {
      showToast('error', `Saved, but ${packed.missingAssets.length === 1 ? 'one image is' : `${packed.missingAssets.length} images are`} missing and could not be included.`);
    } else if (packed.missingFonts.length) {
      showToast('error', `Saved, but the font ${packed.missingFonts.join(', ')} is missing from this computer and could not be included.`);
    } else if (platformKind() === 'browser-downloads') {
      showToast('success', `Downloaded ${file.name}. Keep this file: it is your copy of the project.`);
    } else {
      showToast('success', `Saved ${file.name}`);
    }
    return true;
  } catch (error) {
    showToast('error', `The project could not be saved, and your previous file was not changed. ${messageOf(error)}`);
    return false;
  } finally {
    store.setState({ busy: null });
  }
}

export function renameProject(name: string): void {
  apply('Rename design', (doc) => renameDocument(doc, name));
}

// ----------------------------------------------------------------- content

function sniffImageType(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  const tag = (offset: number) => String.fromCharCode(...b.subarray(offset, offset + 4));
  if (b.length > 12 && tag(0) === 'RIFF' && tag(8) === 'WEBP') return 'image/webp';
  if (b.length > 12 && tag(4) === 'ftyp' && (tag(8) === 'avif' || tag(8) === 'avis')) return 'image/avif';
  return null;
}

/** Add image files as new photo layers. All files in one call are one undo step. */
export async function importImages(files: readonly Blob[]): Promise<NodeId[]> {
  if (!selectDoc(store.getState()) || files.length === 0) return [];
  leaveModes();
  const added: AssetInfo[] = [];
  const failures: string[] = [];
  let storageFull = false;
  for (const file of files) {
    const name = file instanceof File && file.name ? file.name : 'Pasted image';
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Trust the bytes over the reported type.
      const mime = sniffImageType(bytes) ?? file.type;
      if (!SUPPORTED_IMAGE_TYPES.includes(mime)) throw new Error('unsupported');
      const bitmap = await decodeImage(bytes, mime);
      const { width, height } = bitmap;
      bitmap.close();
      const id = await sha256Hex(bytes);
      if (!(await assets.has(id))) await assets.put({ id, mime, bytes });
      added.push({ id, kind: 'image', mime, bytes: bytes.length, width, height, name });
    } catch (error) {
      if (isQuotaError(error)) storageFull = true;
      failures.push(name);
    }
  }
  const ids: NodeId[] = [];
  if (added.length) {
    apply(added.length === 1 ? 'Add photo' : `Add ${added.length} photos`, (doc) => {
      let next = doc;
      const page = firstPage(doc);
      added.forEach((asset, index) => {
        const node = makeImageNode(asset, page);
        node.x += index * 24;
        node.y += index * 24;
        ids.push(node.id);
        next = addNode(addAsset(next, asset), node);
      });
      return next;
    });
    setSelection(ids);
  }
  if (storageFull) {
    showToast('error', 'Browser storage is full, so some photos could not be added.');
  } else if (failures.length) {
    showToast('error', `${failures.join(', ')} could not be added. Use a PNG, JPEG, WebP, GIF or AVIF image.`);
  }
  return ids;
}

export async function addPhotosFromPicker(): Promise<void> {
  const files = await pickFiles(SUPPORTED_IMAGE_TYPES.join(','), true);
  await importImages(files);
}

/** Add another copy of a photo that is already in the project. */
export function addPhotoFromAsset(asset: AssetInfo): void {
  leaveModes();
  const node = makeImageNode(asset, firstPage(currentDoc()));
  apply('Add photo', (doc) => addNode(addAsset(doc, asset), node));
  setSelection([node.id]);
}

export function addText(preset: TextPreset, startTyping = false): void {
  leaveModes();
  const node = makeTextNode(firstPage(currentDoc()), preset);
  apply('Add text', (doc) => addNode(doc, node));
  setSelection([node.id]);
  if (startTyping) {
    // Wait for the canvas to draw the new layer before starting to type in it.
    setTimeout(() => editorRef.current?.editText(node.id), 60);
  }
}

// ----------------------------------------------------------------- editing

export function selectedNodes(): DesignNode[] {
  const state = store.getState();
  const doc = selectDoc(state);
  if (!doc) return [];
  return state.selection.flatMap((id) => {
    const found = findNode(doc, id);
    return found ? [found.node] : [];
  });
}

function patchesFor(ids: readonly NodeId[], patch: NodePatch | ((node: DesignNode) => NodePatch)): Record<NodeId, NodePatch> {
  const doc = currentDoc();
  const patches: Record<NodeId, NodePatch> = {};
  for (const id of ids) {
    const found = findNode(doc, id);
    if (!found) continue;
    patches[id] = typeof patch === 'function' ? patch(found.node) : patch;
  }
  return patches;
}

export function updateNodesById(
  ids: readonly NodeId[],
  patch: NodePatch | ((node: DesignNode) => NodePatch),
  label: string,
): void {
  apply(label, (doc) => updateNodes(doc, patchesFor(ids, patch)));
}

export function updateSelection(patch: NodePatch | ((node: DesignNode) => NodePatch), label: string): void {
  updateNodesById(store.getState().selection, patch, label);
}

/** Like `updateSelection`, for sliders: the whole drag becomes one undo step. */
export function updateSelectionLive(patch: NodePatch | ((node: DesignNode) => NodePatch), label: string, key: string): void {
  const { selection } = store.getState();
  commitDocLive(updateNodes(currentDoc(), patchesFor(selection, patch)), label, `${key}:${selection.join(',')}`);
}

/** Replace nodes with new versions of themselves, as one undo step. Used by the canvas. */
export function commitNodes(nodes: readonly DesignNode[], label: string): void {
  apply(label, (doc) => nodes.reduce(replaceNode, doc));
}

export function removeNodesById(ids: readonly NodeId[], label: string): void {
  apply(label, (doc) => removeNodes(doc, ids));
}

export function deleteSelection(): void {
  const { selection } = store.getState();
  if (!selection.length) return;
  leaveModes();
  removeNodesById(selection, selection.length > 1 ? `Delete ${selection.length} layers` : 'Delete layer');
  setSelection([]);
}

export function duplicateSelection(): void {
  const { selection } = store.getState();
  if (!selection.length) return;
  leaveModes();
  const result = duplicateNodes(currentDoc(), selection);
  if (commitDoc(result.doc, selection.length > 1 ? `Duplicate ${selection.length} layers` : 'Duplicate layer')) {
    setSelection(result.ids);
  }
}

export function nudgeSelection(dx: number, dy: number): void {
  updateSelection((node) => (node.locked ? {} : { x: node.x + dx, y: node.y + dy }), 'Nudge');
}

export function reorderNode(id: NodeId, move: StackMove): void {
  const labels: Record<StackMove, string> = {
    forward: 'Bring forward',
    backward: 'Send backward',
    front: 'Bring to front',
    back: 'Send to back',
  };
  apply(labels[move], (doc) => shiftNode(doc, id, move));
}

export function flipSelection(axis: 'x' | 'y'): void {
  updateSelection(
    (node) => (node.type === 'image' ? (axis === 'x' ? { flipX: !node.flipX } : { flipY: !node.flipY }) : {}),
    axis === 'x' ? 'Flip horizontally' : 'Flip vertically',
  );
}

export function selectAll(): void {
  const doc = selectDoc(store.getState());
  if (!doc) return;
  setSelection(firstPage(doc).nodes.filter((n) => n.visible && !n.locked).map((n) => n.id));
}

export function undo(): void {
  leaveModes();
  undoInStore();
}

export function redo(): void {
  leaveModes();
  redoInStore();
}

// -------------------------------------------------------------------- crop

export function startCrop(id?: NodeId): void {
  const editor = editorRef.current;
  const target = id ?? store.getState().selection[0];
  if (!editor || !target) return;
  editor.finishTextEditing();
  if (editor.enterCrop(target)) store.setState({ cropNodeId: target, selection: [target] });
}

export function applyCrop(): void {
  editorRef.current?.applyCrop();
}

export function cancelCrop(): void {
  editorRef.current?.cancelCrop();
}

// -------------------------------------------------------------------- page

export function setPageSize(width: number, height: number): void {
  leaveModes();
  apply('Resize page', (doc) => resizePage(doc, firstPage(doc).id, width, height));
}

export function setPageBackground(background: string | null, liveKey?: string): void {
  const next = updatePage(currentDoc(), firstPage(currentDoc()).id, { background });
  if (liveKey) commitDocLive(next, 'Change background', liveKey);
  else commitDoc(next, 'Change background');
}

// --------------------------------------------------------------- clipboard

let clipboard: { nodes: DesignNode[]; assets: AssetInfo[]; fonts: DocumentFont[] } | null = null;
let pasteCount = 0;

/** Copy the selected layers. They stay fully editable when pasted. */
export function copySelection(): boolean {
  const nodes = selectedNodes();
  if (!nodes.length) return false;
  const doc = currentDoc();
  clipboard = {
    nodes: structuredClone(nodes),
    // A photo brings its original and, if it has one, its enlarged copy.
    assets: nodes.flatMap((n) => (n.type === 'image' ? [n.assetId, n.upscale?.assetId] : [])).flatMap((id) => (id && doc.assets[id] ? [doc.assets[id]!] : [])),
    // Text keeps its font when pasted into another design.
    fonts: [...new Set(nodes.flatMap((n) => (n.type === 'text' ? [n.fontFamily] : [])))].flatMap((family) => documentFont(doc, family) ?? []),
  };
  pasteCount = 0;
  return true;
}

export function cutSelection(): void {
  if (copySelection()) deleteSelection();
}

export function hasClipboard(): boolean {
  return !!clipboard;
}

export function pasteClipboard(): void {
  if (!clipboard) return;
  leaveModes();
  pasteCount++;
  const offset = 24 * pasteCount;
  const nodes = clipboard.nodes.map((node) => ({ ...structuredClone(node), id: newId(node.type), x: node.x + offset, y: node.y + offset }));
  const { assets: clipboardAssets, fonts: clipboardFonts } = clipboard;
  apply(nodes.length > 1 ? `Paste ${nodes.length} layers` : 'Paste', (doc) => insertNodes(doc, nodes, clipboardAssets, clipboardFonts));
  setSelection(nodes.map((n) => n.id));
}

// ------------------------------------------------------------------ export

export function exportFileName(doc: DesignDocument, width: number, height: number, format: 'png' | 'jpeg'): string {
  const base = doc.name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled design';
  return `${base} ${width}x${height}.${format === 'png' ? 'png' : 'jpg'}`;
}

/** Render the page and hand it to the person as a file. */
export async function exportImage(options: ExportOptions): Promise<{ result: ExportResult; fileName: string | null }> {
  leaveModes();
  const doc = currentDoc();
  const result = await exportPage(doc, firstPage(doc), images, options);
  const fileName = await saveExportFile(result.blob, exportFileName(doc, result.width, result.height, options.format));
  return { result, fileName };
}
