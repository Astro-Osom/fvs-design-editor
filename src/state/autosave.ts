import { firstPage } from '../document/ops';
import type { DesignDocument } from '../document/types';
import { exportPage } from '../render/exportPage';
import { isQuotaError } from '../storage/idb';
import { putProject } from '../storage/projectsDb';
import { images } from './services';
import { selectDoc, store } from './store';

/**
 * Autosave to browser storage, with a visible state (saving, saved, failed).
 *
 * This is the safety net behind the recent-projects screen and crash recovery.
 * A failed autosave never touches the previous good copy, and the person is told
 * to save a project file, which is the copy they control.
 */

const DELAY_MS = 700;

let timer: ReturnType<typeof setTimeout> | null = null;
let running: Promise<void> | null = null;
let written: { doc: DesignDocument; savedDoc: DesignDocument | null } | null = null;
let savedToFileAt: string | null = null;
let askedForPersistence = false;

export function noteSavedToFile(): void {
  savedToFileAt = new Date().toISOString();
}

export function resetAutosave(initialSavedToFileAt: string | null = null): void {
  if (timer) clearTimeout(timer);
  timer = null;
  written = null;
  savedToFileAt = initialSavedToFileAt;
}

async function makeThumbnail(doc: DesignDocument): Promise<Uint8Array | null> {
  try {
    const result = await exportPage(doc, firstPage(doc), images, {
      format: 'png',
      width: 320,
      usePreviews: true,
      allowProblems: true,
    });
    return new Uint8Array(await result.blob.arrayBuffer());
  } catch {
    return null;
  }
}

async function writeNow(): Promise<void> {
  const state = store.getState();
  const doc = selectDoc(state);
  if (!doc) return;
  if (written && written.doc === doc && written.savedDoc === state.savedDoc) return;
  store.setState({ autosave: { kind: 'saving' } });
  try {
    const page = firstPage(doc);
    const thumbnail = await makeThumbnail(doc);
    await putProject({
      id: doc.id,
      name: doc.name,
      doc,
      updatedAt: new Date().toISOString(),
      savedToFileAt,
      hasUnsavedFileChanges: doc !== state.savedDoc,
      width: page.width,
      height: page.height,
      thumbnail,
    });
    written = { doc, savedDoc: state.savedDoc };
    // Only report "saved" if this is still the open document.
    if (selectDoc(store.getState())?.id === doc.id) store.setState({ autosave: { kind: 'saved', at: Date.now() } });
    if (!askedForPersistence && navigator.storage?.persist) {
      askedForPersistence = true;
      // Ask the browser not to evict our storage under pressure. It may say no.
      void navigator.storage.persist().catch(() => false);
    }
  } catch (error) {
    const message = isQuotaError(error)
      ? 'Browser storage is full, so autosave is off. Save a project file to keep your work.'
      : 'Autosave is not working in this browser. Save a project file to keep your work.';
    if (selectDoc(store.getState())?.id === doc.id) store.setState({ autosave: { kind: 'failed', message } });
  }
}

function run(): Promise<void> {
  // One write at a time; a change during a write triggers another afterwards.
  running = (running ?? Promise.resolve()).then(writeNow).finally(() => {
    running = null;
  });
  return running;
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void run();
  }, DELAY_MS);
}

/** Write any pending changes immediately (before closing a project, for example). */
export async function flushAutosave(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await run();
}

export function startAutosave(): () => void {
  const unsubscribe = store.subscribe((state, previous) => {
    const doc = selectDoc(state);
    if (!doc) return;
    if (doc !== selectDoc(previous) || state.savedDoc !== previous.savedDoc) schedule();
  });
  const onHide = () => {
    if (document.visibilityState === 'hidden') void flushAutosave();
  };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onHide);
  return () => {
    unsubscribe();
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', onHide);
  };
}

// ------------------------------------------------- one project, one window

let releaseLock: (() => void) | null = null;
let claimToken = 0;

/**
 * Notice when the same project is open in another tab or window. Two editors
 * autosaving the same project would overwrite each other, so the second one warns.
 */
export function claimProject(id: string): void {
  releaseProject();
  if (!navigator.locks) return;
  const token = ++claimToken;
  void navigator.locks.request(`fvs-design-project:${id}`, { ifAvailable: true }, (lock) => {
    // A newer claim has replaced this one: let the lock go straight away.
    if (token !== claimToken) return undefined;
    if (!lock) {
      if (selectDoc(store.getState())?.id === id) {
        store.setState((s) => ({ warnings: { ...s.warnings, openElsewhere: true } }));
      }
      return undefined;
    }
    return new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
  });
}

export function releaseProject(): void {
  claimToken++;
  releaseLock?.();
  releaseLock = null;
}
