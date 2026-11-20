import { contextBridge, ipcRenderer } from 'electron';

/**
 * The only bridge between the page and the desktop: three file operations.
 * See `DesktopBridge` in src/platform/files.ts.
 */
contextBridge.exposeInMainWorld('fvsDesktop', {
  openProject: () => ipcRenderer.invoke('project:open'),
  saveProject: (args: { path: string | null; suggestedName: string; data: Uint8Array }) =>
    ipcRenderer.invoke('project:save', args),
  saveExport: (args: { suggestedName: string; data: Uint8Array }) => ipcRenderer.invoke('export:save', args),
});
