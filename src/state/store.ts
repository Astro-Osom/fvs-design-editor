import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { AssetId, DesignDocument, FontUse, NodeId } from '../document/types';
import {
  canRedo,
  canUndo,
  commit as commitHistory,
  createHistory,
  jumpTo as jumpHistory,
  present,
  redo as redoHistory,
  undo as undoHistory,
  type History,
} from './history';

/**
 * Editor state. These concerns are kept apart on purpose:
 *
 * - `history`          the document and its undo steps (the only thing that is saved)
 * - `selection`, `cropNodeId`, `editingText`, `leftPanel`, `dialog`   what the person is doing
 * - `zoom`             the viewport (owned by the canvas controller; mirrored here for display)
 * - `file`, `savedDoc`, `autosave`   where the project lives and whether it is safe
 *
 * Original image bytes live in the asset store and Fabric objects live in the
 * canvas controller; neither is in this store.
 */

export type AutosaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'failed'; message: string };

export interface ProjectFile {
  name: string;
  /** Browser file handle, when the File System Access API is available. */
  handle?: FileSystemFileHandle;
  /** Absolute path, in the desktop app. */
  path?: string;
}

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  message: string;
}

export interface Warnings {
  missingAssets: AssetId[];
  missingFonts: FontUse[];
  /** Photo layers whose enlarged copy cannot be found, so the original is shown instead. */
  lostEnlargements: NodeId[];
  openElsewhere: boolean;
}

export type LeftPanel = 'photos' | 'text' | 'page';

export interface EditorState {
  screen: 'start' | 'editor';
  history: History<DesignDocument> | null;
  /** The document object most recently written to a project file, to tell whether there are unsaved changes. */
  savedDoc: DesignDocument | null;
  file: ProjectFile | null;
  autosave: AutosaveState;
  selection: NodeId[];
  cropNodeId: NodeId | null;
  editingText: boolean;
  zoom: number;
  leftPanel: LeftPanel | null;
  dialog: 'export' | 'upscale' | null;
  warnings: Warnings;
  toast: Toast | null;
  /** A short message while something slow is happening, e.g. "Saving…". */
  busy: string | null;
}

const noWarnings: Warnings = { missingAssets: [], missingFonts: [], lostEnlargements: [], openElsewhere: false };

const initialState: EditorState = {
  screen: 'start',
  history: null,
  savedDoc: null,
  file: null,
  autosave: { kind: 'idle' },
  selection: [],
  cropNodeId: null,
  editingText: false,
  zoom: 1,
  leftPanel: 'photos',
  dialog: null,
  warnings: noWarnings,
  toast: null,
  busy: null,
};

export const store = createStore<EditorState>(() => initialState);

export function useEditor<T>(selector: (state: EditorState) => T): T {
  return useStore(store, selector);
}

// ------------------------------------------------------------- selectors

export const selectDoc = (s: EditorState): DesignDocument | null => (s.history ? present(s.history) : null);
export const selectPage = (s: EditorState) => selectDoc(s)?.pages[0] ?? null;
export const selectCanUndo = (s: EditorState) => !!s.history && canUndo(s.history);
export const selectCanRedo = (s: EditorState) => !!s.history && canRedo(s.history);
export const selectHasUnsavedFileChanges = (s: EditorState) => !!s.history && present(s.history) !== s.savedDoc;

export function currentDoc(): DesignDocument {
  const doc = selectDoc(store.getState());
  if (!doc) throw new Error('No document is open');
  return doc;
}

// ---------------------------------------------------------------- updates

let toastId = 0;

export function showToast(kind: Toast['kind'], message: string): void {
  store.setState({ toast: { id: ++toastId, kind, message } });
}

export function dismissToast(id?: number): void {
  const { toast } = store.getState();
  if (toast && (id === undefined || toast.id === id)) store.setState({ toast: null });
}

/** Show a freshly created or opened document, with a clean history. */
export function openDocumentInStore(
  doc: DesignDocument,
  options: { label: string; file?: ProjectFile | null; saved?: boolean; warnings?: Partial<Warnings> },
): void {
  store.setState({
    screen: 'editor',
    history: createHistory(doc, options.label),
    savedDoc: options.saved ? doc : null,
    file: options.file ?? null,
    autosave: { kind: 'idle' },
    selection: [],
    cropNodeId: null,
    editingText: false,
    dialog: null,
    warnings: { ...noWarnings, ...options.warnings },
    busy: null,
  });
}

export function closeDocumentInStore(): void {
  store.setState({ ...initialState, toast: store.getState().toast });
}

/** Record one undo step. Returns false if the document did not actually change. */
export function commitDoc(next: DesignDocument, label: string): boolean {
  gestureKey = null;
  return pushStep(next, label);
}

function pushStep(next: DesignDocument, label: string): boolean {
  const { history } = store.getState();
  if (!history) return false;
  const updated = commitHistory(history, next, label);
  if (updated === history) return false;
  store.setState({ history: updated });
  return true;
}

function keepExistingSelection(doc: DesignDocument, selection: NodeId[]): NodeId[] {
  const ids = new Set(doc.pages.flatMap((p) => p.nodes.map((n) => n.id)));
  const kept = selection.filter((id) => ids.has(id));
  return kept.length === selection.length ? selection : kept;
}

function moveInHistory(move: (h: History<DesignDocument>) => History<DesignDocument>): void {
  gestureKey = null;
  const state = store.getState();
  if (!state.history) return;
  const updated = move(state.history);
  if (updated === state.history) return;
  store.setState({
    history: updated,
    selection: keepExistingSelection(present(updated), state.selection),
    cropNodeId: null,
  });
}

export const undo = () => moveInHistory(undoHistory);
export const redo = () => moveInHistory(redoHistory);
export const jumpToHistory = (index: number) => moveInHistory((h) => jumpHistory(h, index));

export function setSelection(ids: NodeId[]): void {
  const current = store.getState().selection;
  if (current.length === ids.length && current.every((id, i) => id === ids[i])) return;
  store.setState({ selection: ids });
}

// --------------------------------------------------------------- gestures

let gestureKey: string | null = null;

/**
 * Record a change that is part of a continuous gesture, such as dragging a slider.
 * The first call adds one undo step; later calls with the same key update that
 * step instead of adding more. Call `endGesture` when the gesture finishes.
 */
export function commitDocLive(next: DesignDocument, label: string, key: string): void {
  const { history } = store.getState();
  if (!history) return;
  if (gestureKey === key && history.index === history.entries.length - 1 && history.index > 0) {
    if (next === present(history)) return;
    const entries = history.entries.slice();
    entries[history.index] = { state: next, label };
    store.setState({ history: { ...history, entries } });
    return;
  }
  if (pushStep(next, label)) gestureKey = key;
}

export function endGesture(): void {
  gestureKey = null;
}
