import { PROJECT_FILE_EXTENSION, PROJECT_FILE_MIME } from '../storage/projectFile';
import type { ProjectFile } from '../state/store';

/**
 * Opening and saving files, behind one interface with three implementations:
 *
 * - the desktop app, through a small bridge to the main process;
 * - browsers with the File System Access API (save in place);
 * - every other browser (pick with a file input, save as a download).
 *
 * Writes never touch the previous good file until the new one is complete: the
 * desktop app writes a temporary file and renames it, and the browser API swaps
 * the file only when the stream is closed.
 */

export interface DesktopBridge {
  openProject(): Promise<{ path: string; name: string; data: Uint8Array } | null>;
  saveProject(args: { path: string | null; suggestedName: string; data: Uint8Array }): Promise<{ path: string; name: string } | null>;
  saveExport(args: { suggestedName: string; data: Uint8Array }): Promise<{ path: string; name: string } | null>;
}

declare global {
  interface Window {
    fvsDesktop?: DesktopBridge;
  }
}

interface PickerType {
  description: string;
  accept: Record<string, string[]>;
}

interface FsAccessWindow {
  showOpenFilePicker(options: { types: PickerType[]; multiple?: boolean }): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker(options: { suggestedName: string; types: PickerType[] }): Promise<FileSystemFileHandle>;
}

function fsAccess(): FsAccessWindow | null {
  const w = window as unknown as Partial<FsAccessWindow>;
  return typeof w.showOpenFilePicker === 'function' && typeof w.showSaveFilePicker === 'function'
    ? (w as FsAccessWindow)
    : null;
}

export type PlatformKind = 'desktop' | 'browser-files' | 'browser-downloads';

export function platformKind(): PlatformKind {
  if (window.fvsDesktop) return 'desktop';
  return fsAccess() ? 'browser-files' : 'browser-downloads';
}

const PROJECT_TYPES: PickerType[] = [
  { description: 'Design project', accept: { [PROJECT_FILE_MIME]: [`.${PROJECT_FILE_EXTENSION}`] } },
];

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** Ask for files with a plain file input. Resolves to an empty list if the person cancels. */
export function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    input.setAttribute('data-testid', 'file-input');
    const finish = (files: File[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])));
    input.addEventListener('cancel', () => finish([]));
    document.body.appendChild(input);
    input.click();
  });
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // The URL is only a way to hand the bytes to the browser; let go of it afterwards.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function writeToHandle(handle: FileSystemFileHandle, data: Blob): Promise<void> {
  const writable = await handle.createWritable();
  try {
    await writable.write(data);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
}

export interface OpenedProject {
  bytes: Uint8Array;
  file: ProjectFile;
}

export async function openProjectFile(): Promise<OpenedProject | null> {
  if (window.fvsDesktop) {
    const result = await window.fvsDesktop.openProject();
    return result ? { bytes: new Uint8Array(result.data), file: { name: result.name, path: result.path } } : null;
  }
  const fs = fsAccess();
  if (fs) {
    try {
      const [handle] = await fs.showOpenFilePicker({ types: PROJECT_TYPES });
      if (!handle) return null;
      const file = await handle.getFile();
      return { bytes: new Uint8Array(await file.arrayBuffer()), file: { name: file.name, handle } };
    } catch (error) {
      if (isAbort(error)) return null;
      throw error;
    }
  }
  const [file] = await pickFiles(`.${PROJECT_FILE_EXTENSION}`, false);
  return file ? { bytes: new Uint8Array(await file.arrayBuffer()), file: { name: file.name } } : null;
}

/**
 * Save a project. With `existing` and no `saveAs`, the same file is written again
 * where that is possible. Returns null if the person cancelled.
 */
export async function saveProjectFile(
  bytes: Uint8Array,
  suggestedName: string,
  existing: ProjectFile | null,
  saveAs: boolean,
): Promise<ProjectFile | null> {
  if (window.fvsDesktop) {
    const result = await window.fvsDesktop.saveProject({
      path: !saveAs && existing?.path ? existing.path : null,
      suggestedName,
      data: bytes,
    });
    return result ? { name: result.name, path: result.path } : null;
  }
  const blob = new Blob([bytes as BlobPart], { type: PROJECT_FILE_MIME });
  const fs = fsAccess();
  if (fs) {
    try {
      const handle =
        !saveAs && existing?.handle ? existing.handle : await fs.showSaveFilePicker({ suggestedName, types: PROJECT_TYPES });
      await writeToHandle(handle, blob);
      return { name: handle.name, handle };
    } catch (error) {
      if (isAbort(error)) return null;
      throw error;
    }
  }
  download(blob, suggestedName);
  return { name: suggestedName };
}

/** Save an exported image. Returns the file name used, or null if cancelled. */
export async function saveExportFile(blob: Blob, suggestedName: string): Promise<string | null> {
  if (window.fvsDesktop) {
    const result = await window.fvsDesktop.saveExport({ suggestedName, data: new Uint8Array(await blob.arrayBuffer()) });
    return result ? result.name : null;
  }
  const fs = fsAccess();
  if (fs) {
    try {
      const extension = suggestedName.slice(suggestedName.lastIndexOf('.'));
      const handle = await fs.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'Image', accept: { [blob.type]: [extension] } }],
      });
      await writeToHandle(handle, blob);
      return handle.name;
    } catch (error) {
      if (isAbort(error)) return null;
      throw error;
    }
  }
  download(blob, suggestedName);
  return suggestedName;
}
