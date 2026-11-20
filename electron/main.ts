import { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell } from 'electron';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Desktop shell. It shows the same web build as the browser version and adds
 * native open and save dialogs. The page has no Node access: it can only ask for
 * the three file operations below, through the preload bridge.
 */

const APP_SCHEME = 'app';
const APP_HOST = 'editor';
const DIST = path.join(__dirname, '..', 'dist');
const PROJECT_FILTER = [{ name: 'Design project', extensions: ['fvsdesign'] }];

// A proper origin (instead of file://) gives the page stable storage and a secure context.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// The page may only load its own files. The single exception is Google Fonts: when
// the person picks a Google font, its stylesheet and files are fetched from Google's
// two font hosts (see src/fonts/googleDownload.ts). Nothing else can be contacted.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function registerAppProtocol(): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return new Response('Not found', { status: 404 });
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const filePath = path.normalize(path.join(DIST, relative));
    // Never serve anything outside the app's own files.
    if (filePath !== DIST && !filePath.startsWith(DIST + path.sep)) return new Response('Forbidden', { status: 403 });
    const response = await net.fetch(pathToFileURL(filePath).toString());
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    return new Response(response.body, { status: response.status, headers });
  });
}

/** Write a file so that a failure part-way through cannot damage an existing file. */
async function writeFileAtomic(target: string, data: Uint8Array): Promise<void> {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const handle = await fs.open(temp, 'w');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function cleanName(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? path.basename(value) : fallback;
}

function registerFileHandlers(): void {
  ipcMain.handle('project:open', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = { properties: ['openFile' as const], filters: PROJECT_FILTER };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    const filePath = result.filePaths[0];
    if (result.canceled || !filePath) return null;
    const data = await fs.readFile(filePath);
    return { path: filePath, name: path.basename(filePath), data: new Uint8Array(data) };
  });

  ipcMain.handle('project:save', async (event, args: { path?: unknown; suggestedName?: unknown; data?: unknown }) => {
    if (!args || !isBytes(args.data)) throw new Error('Nothing to save');
    let target = typeof args.path === 'string' && path.isAbsolute(args.path) ? args.path : null;
    if (!target) {
      const window = BrowserWindow.fromWebContents(event.sender);
      const options = { defaultPath: cleanName(args.suggestedName, 'Untitled design.fvsdesign'), filters: PROJECT_FILTER };
      const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return null;
      target = result.filePath;
    }
    await writeFileAtomic(target, args.data);
    return { path: target, name: path.basename(target) };
  });

  ipcMain.handle('export:save', async (event, args: { suggestedName?: unknown; data?: unknown }) => {
    if (!args || !isBytes(args.data)) throw new Error('Nothing to save');
    const name = cleanName(args.suggestedName, 'export.png');
    const extension = path.extname(name).slice(1) || 'png';
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = { defaultPath: name, filters: [{ name: 'Image', extensions: [extension] }] };
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    await writeFileAtomic(result.filePath, args.data);
    return { path: result.filePath, name: path.basename(result.filePath) };
  });
}

/**
 * Browser permissions. Electron grants every permission by default; the editor
 * needs exactly one: listing the fonts installed on the computer, which the
 * person asks for from the font menu. Everything else (camera, location,
 * notifications and so on) is refused.
 */
const ALLOWED_PERMISSIONS = new Set(['local-fonts']);

function restrictPermissions(): void {
  const fromApp = (url: string | undefined) => !!url && url.startsWith(`${APP_SCHEME}://${APP_HOST}/`);
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin) => ALLOWED_PERMISSIONS.has(permission) && fromApp(`${origin}/`));
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && fromApp(contents.getURL()));
  });
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#16171b',
    title: 'FVS Design Editor',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // The editor is a single local page: open links in the system browser and never navigate away.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${APP_SCHEME}://${APP_HOST}/`)) event.preventDefault();
  });
  void window.loadURL(`${APP_SCHEME}://${APP_HOST}/index.html`);
}

void app.whenReady().then(() => {
  registerAppProtocol();
  registerFileHandlers();
  restrictPermissions();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
