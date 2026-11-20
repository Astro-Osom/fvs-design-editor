import { expect, type Download, type Locator, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';

/** A deterministic test photo, drawn in the page: coloured blocks and shapes, no text. */
export async function makePhoto(page: Page, width = 1600, height = 1200): Promise<Buffer> {
  const base64 = await page.evaluate(
    ([w, h]) => {
      const canvas = document.createElement('canvas');
      canvas.width = w!;
      canvas.height = h!;
      const g = canvas.getContext('2d')!;
      const colours = ['#e63946', '#2a9d8f', '#e9c46a', '#264653'];
      [
        [0, 0],
        [w! / 2, 0],
        [0, h! / 2],
        [w! / 2, h! / 2],
      ].forEach(([x, y], i) => {
        g.fillStyle = colours[i]!;
        g.fillRect(x!, y!, w! / 2, h! / 2);
      });
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(w! / 2, h! / 2, h! / 5, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#1d3557';
      for (let i = 0; i < 12; i++) g.fillRect(40 + i * 120, 40 + ((i * 53) % 200), 60, 60);
      return canvas.toDataURL('image/png').split(',')[1]!;
    },
    [width, height],
  );
  return Buffer.from(base64, 'base64');
}

/** Pixel size of a PNG, read from its header. */
export function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Pixel size of a JPEG, read from its start-of-frame marker. */
export function jpegSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.readUInt16BE(0)).toBe(0xffd8);
  let offset = 2;
  while (offset < bytes.length) {
    const marker = bytes.readUInt16BE(offset);
    const length = bytes.readUInt16BE(offset + 2);
    if (marker >= 0xffc0 && marker <= 0xffcf && marker !== 0xffc4 && marker !== 0xffc8 && marker !== 0xffcc) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  throw new Error('No JPEG frame header found');
}

export async function readDownload(download: Download): Promise<Buffer> {
  const path = await download.path();
  return fs.readFile(path);
}

/** Make the app use plain file inputs and downloads, which the test can drive. */
export async function useBasicFileAccess(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showOpenFilePicker', { value: undefined, configurable: true });
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
  });
}

/** Where a page coordinate is on screen, using the viewport the canvas publishes. */
export async function pageToScreen(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const host = page.getByTestId('canvas-host');
  const box = (await host.boundingBox())!;
  const view = await host.evaluate((el) => ({
    zoom: Number((el as HTMLElement).dataset.zoom),
    panX: Number((el as HTMLElement).dataset.panX),
    panY: Number((el as HTMLElement).dataset.panY),
  }));
  return { x: box.x + view.panX + x * view.zoom, y: box.y + view.panY + y * view.zoom };
}

export async function zoomOf(page: Page): Promise<number> {
  return page.getByTestId('canvas-host').evaluate((el) => Number((el as HTMLElement).dataset.zoom));
}

export function field(page: Page, label: string): Locator {
  return page.getByTestId('position-panel').getByLabel(label, { exact: true });
}

export async function numberIn(locator: Locator): Promise<number> {
  return Number(await locator.inputValue());
}

export async function setField(locator: Locator, value: number | string): Promise<void> {
  await locator.fill(String(value));
  await locator.press('Enter');
}

export async function historyLength(page: Page): Promise<number> {
  const list = page.getByTestId('history');
  if (!(await list.isVisible())) await page.getByRole('button', { name: /Show \d+ steps/ }).click();
  return list.locator('li').count();
}

export async function addPhoto(page: Page, photo: Buffer, name = 'photo.png'): Promise<void> {
  await page.getByTestId('rail-photos').click().catch(() => undefined);
  if (!(await page.getByTestId('add-photo').isVisible())) await page.getByTestId('rail-photos').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('add-photo').click();
  await (await chooser).setFiles({ name, mimeType: 'image/png', buffer: photo });
}

export async function addHeadline(page: Page): Promise<void> {
  if (!(await page.getByTestId('add-text-headline').isVisible())) await page.getByTestId('rail-text').click();
  await page.getByTestId('add-text-headline').click();
}

export interface ExportChoice {
  /** Text of the size button, e.g. "3840 × 2160". Omit to keep the page size. */
  size?: string;
  format?: 'PNG' | 'JPG';
  /** JPG only: tick "Keep the file under" with this many megabytes. */
  maxMb?: number;
}

/** Export through the dialog and return the downloaded bytes. */
export async function exportThroughDialog(page: Page, choice: ExportChoice = {}): Promise<Buffer> {
  await page.getByTestId('export-button').click();
  const dialog = page.getByTestId('export-dialog');
  await expect(dialog).toBeVisible();
  if (choice.format) await dialog.getByText(choice.format, { exact: true }).click();
  if (choice.size) await dialog.getByRole('button', { name: choice.size }).click();
  if (choice.maxMb !== undefined) {
    await dialog.getByLabel('Keep the file under').check();
    await setField(dialog.getByLabel('Largest file size in megabytes'), choice.maxMb);
  }
  const download = page.waitForEvent('download');
  await page.getByTestId('export-confirm').click();
  const bytes = await readDownload(await download);
  // The dialog closes itself unless it has notes to show.
  await dialog.getByRole('button', { name: 'Done' }).click({ timeout: 1500 }).catch(() => undefined);
  await expect(dialog).toBeHidden();
  return bytes;
}
