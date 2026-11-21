import type { DesignDocument } from '../document/types';
import { openDatabase, requestToPromise, transactionDone } from './idb';

/**
 * Autosaved projects in browser storage. This backs the recent-projects screen
 * and crash recovery. It is a convenience copy: the reliable copy is the project
 * file the person saves themselves.
 */
export interface StoredProject {
  id: string;
  name: string;
  doc: DesignDocument;
  /** ISO time of the last autosave. */
  updatedAt: string;
  /** ISO time of the last save to a project file, or null if never saved to a file. */
  savedToFileAt: string | null;
  /** True when there are changes that have not been written to a project file. */
  hasUnsavedFileChanges: boolean;
  width: number;
  height: number;
  /** Small PNG preview as raw bytes. */
  thumbnail: Uint8Array | null;
}

export type ProjectSummary = Omit<StoredProject, 'doc'>;

export async function putProject(project: StoredProject): Promise<void> {
  const db = await openDatabase();
  // A single readwrite transaction either fully replaces the record or leaves the
  // previous one untouched, so a failed write never destroys the last good autosave.
  const tx = db.transaction('projects', 'readwrite');
  tx.objectStore('projects').put(project);
  await transactionDone(tx);
}

export async function getProject(id: string): Promise<StoredProject | undefined> {
  const db = await openDatabase();
  return requestToPromise<StoredProject | undefined>(
    db.transaction('projects', 'readonly').objectStore('projects').get(id),
  );
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const db = await openDatabase();
  const rows = await requestToPromise<StoredProject[]>(
    db.transaction('projects', 'readonly').objectStore('projects').getAll(),
  );
  return rows
    .map(({ doc: _doc, ...summary }) => summary)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction('projects', 'readwrite');
  tx.objectStore('projects').delete(id);
  await transactionDone(tx);
}
