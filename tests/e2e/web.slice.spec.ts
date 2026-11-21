import { expect, test, type Page } from '@playwright/test';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import { promises as fs } from 'node:fs';
import {
  addHeadline,
  addPhoto,
  exportThroughDialog,
  field,
  historyLength,
  jpegSize,
  makePhoto,
  numberIn,
  pageToScreen,
  pickFont,
  pngSize,
  readDownload,
  setField,
  useBasicFileAccess,
  zoomOf,
} from './helpers';

/**
 * The vertical slice, end to end, in the browser:
 * import image -> add styled text -> transform and crop -> undo/redo ->
 * save portable project -> close -> reopen -> export at exact dimensions.
 */

test.beforeEach(async ({ page }) => {
  await useBasicFileAccess(page);
});

test('import, edit, crop, undo, save, reopen and export without any drift', async ({ page }, testInfo) => {
  // The app must not talk to anything but its own origin.
  const external: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith('http://localhost:4173') && !url.startsWith('data:') && !url.startsWith('blob:')) external.push(url);
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));

  await page.goto('/');
  await page.getByTestId('new-thumbnail-720').click();
  await expect(page.getByTestId('editor')).toBeVisible();
  const layers = page.getByTestId('layer-row');

  // ---- import an image: it is fitted inside the page, whole and centred
  const photo = await makePhoto(page);
  await addPhoto(page, photo);
  await expect(layers).toHaveCount(1);
  await expect(field(page, 'Width')).toHaveValue('864');
  await expect(field(page, 'Height')).toHaveValue('648');
  await expect(field(page, 'X position')).toHaveValue('208');
  await expect(field(page, 'Y position')).toHaveValue('36');
  const baseline = await historyLength(page);

  // ---- transform by number: one change, one history step
  await setField(field(page, 'X position'), 100);
  await expect(field(page, 'X position')).toHaveValue('100');
  expect(await historyLength(page)).toBe(baseline + 1);

  // ---- transform by dragging: the whole drag is ONE history step
  const zoom = await zoomOf(page);
  const grab = await pageToScreen(page, 130, 60);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + 20, grab.y + 10, { steps: 4 });
  await page.mouse.move(grab.x + 50, grab.y + 30, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => numberIn(field(page, 'X position'))).toBeCloseTo(100 + 50 / zoom, 0);
  await expect.poll(() => numberIn(field(page, 'Y position'))).toBeCloseTo(36 + 30 / zoom, 0);
  expect(await historyLength(page)).toBe(baseline + 2);

  // Put the photo somewhere exact for the rest of the test.
  await setField(field(page, 'X position'), 120);
  await setField(field(page, 'Y position'), 40);

  // ---- crop: cancelling changes nothing
  await page.getByTestId('crop-button').click();
  await expect(page.getByTestId('crop-apply')).toBeVisible();
  let handle = await pageToScreen(page, 120 + 864, 40 + 324);
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(handle.x - 150, handle.y, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('crop-apply')).toBeHidden();
  await expect(field(page, 'Width')).toHaveValue('864');
  const beforeCrop = await historyLength(page);

  // ---- crop: Enter applies it, as one step, without moving the photo
  await page.getByTestId('crop-button').click();
  handle = await pageToScreen(page, 120 + 864, 40 + 324);
  const dragBy = 864 * 0.4 * zoom;
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(handle.x - dragBy / 2, handle.y, { steps: 6 });
  await page.mouse.move(handle.x - dragBy, handle.y, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('crop-apply')).toBeHidden();
  await expect.poll(() => numberIn(field(page, 'Width'))).toBeCloseTo(864 * 0.6, -1);
  await expect(field(page, 'Height')).toHaveValue('648');
  await expect(field(page, 'X position')).toHaveValue('120');
  expect(await historyLength(page)).toBe(beforeCrop + 1);
  const croppedWidth = await numberIn(field(page, 'Width'));

  // ---- undo restores the crop; redo applies it again
  await page.getByTestId('undo-button').click();
  await expect(field(page, 'Width')).toHaveValue('864');
  await page.getByTestId('redo-button').click();
  await expect.poll(() => numberIn(field(page, 'Width'))).toBeCloseTo(croppedWidth, 3);
  await setField(field(page, 'Rotation'), 8);

  // ---- styled text: one editing session is one history step
  await addHeadline(page);
  await expect(layers).toHaveCount(2);
  const beforeTyping = await historyLength(page);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('context-bar')).toHaveAttribute('data-editing-text', 'true');
  await page.keyboard.type('SAVE CLOSE REOPEN EXPORT 🎉 again');
  // While typing, Backspace edits the text. It must not delete the layer.
  for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('context-bar')).toHaveAttribute('data-editing-text', 'false');
  await expect(layers).toHaveCount(2);
  await expect(layers.first()).toContainText('SAVE CLOSE REOPEN EXPORT 🎉');
  expect(await historyLength(page)).toBe(beforeTyping + 1);

  await layers.first().click();
  await setField(page.getByLabel('Text size'), 110);
  await pickFont(page, 'Montserrat');
  await page.getByLabel('Weight').selectOption('800');
  await setField(field(page, 'Rotation'), -6);
  await setField(field(page, 'Y position'), 420);

  // ---- export at exact dimensions, from a 2x screen
  const exportA = await exportThroughDialog(page, { size: '3840 × 2160' });
  expect(pngSize(exportA)).toEqual({ width: 3840, height: 2160 });
  await fs.writeFile(testInfo.outputPath('export-before-save.png'), exportA);

  // ---- output does not depend on editor zoom
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  expect(await zoomOf(page)).toBeGreaterThan(zoom * 1.5);
  const exportZoomed = await exportThroughDialog(page, { size: '3840 × 2160' });
  expect(exportZoomed.equals(exportA)).toBe(true);

  // ---- JPG: exact size, flattened, and under the requested file size
  const jpeg = await exportThroughDialog(page, { format: 'JPG', maxMb: 0.08 });
  expect(jpegSize(jpeg)).toEqual({ width: 1280, height: 720 });
  expect(jpeg.length).toBeLessThanOrEqual(0.08 * 1024 * 1024);

  await page.screenshot({ path: testInfo.outputPath('editor.png') });

  // ---- save a portable project file
  const saving = page.waitForEvent('download');
  await page.getByTestId('save-button').click();
  const projectDownload = await saving;
  expect(projectDownload.suggestedFilename()).toBe('Untitled design.fvsdesign');
  const projectBytes = await readDownload(projectDownload);
  expect(projectBytes.subarray(0, 2).toString()).toBe('PK');
  // The original image is inside the file, byte for byte.
  expect(projectBytes.includes(photo)).toBe(true);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  // ---- close, then reopen from the project file
  await page.reload();
  await expect(page.getByTestId('start-screen')).toBeVisible();
  const opening = page.waitForEvent('filechooser');
  await page.getByTestId('open-project').click();
  await (await opening).setFiles({ name: 'Untitled design.fvsdesign', mimeType: 'application/octet-stream', buffer: projectBytes });
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(layers).toHaveCount(2);
  await expect(page.getByTestId('warnings')).toHaveCount(0);

  const exportB = await exportThroughDialog(page, { size: '3840 × 2160' });
  // Identical pixels: crop, rotation, fonts and line breaks all survived the round trip.
  expect(exportB.equals(exportA)).toBe(true);

  // ---- reopen again from the automatically saved copy
  await page.getByRole('button', { name: 'Back to your designs' }).click();
  await expect(page.getByTestId('recent-project')).toHaveCount(1);
  await page.getByTestId('recent-project').click();
  await expect(layers).toHaveCount(2);
  const exportC = await exportThroughDialog(page, { size: '3840 × 2160' });
  expect(exportC.equals(exportA)).toBe(true);

  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});

test('a file that is not a project is refused with a clear message', async ({ page }) => {
  await page.goto('/');
  const opening = page.waitForEvent('filechooser');
  await page.getByTestId('open-project').click();
  await (await opening).setFiles({ name: 'holiday.fvsdesign', mimeType: 'application/octet-stream', buffer: Buffer.from('not a project') });
  await expect(page.getByTestId('toast')).toContainText('not a design project');
  await expect(page.getByTestId('toast')).toHaveAttribute('data-kind', 'error');
  await expect(page.getByTestId('start-screen')).toBeVisible();
});

test('every control has a name and the editor works from the keyboard', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('new-thumbnail-720').click();
  await addHeadline(page);
  await expect(page.getByTestId('layer-row')).toHaveCount(1);

  const unnamed = await page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll<HTMLElement>('button, input, select, [role="option"]'));
    return controls
      .filter((el) => {
        const labelled = (el as HTMLInputElement).labels?.length ? Array.from((el as HTMLInputElement).labels!).some((l) => l.textContent?.trim()) : false;
        const name = el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent?.trim() || '';
        return !name && !labelled && el.getAttribute('type') !== 'file';
      })
      .map((el) => el.outerHTML.slice(0, 120));
  });
  expect(unnamed).toEqual([]);

  // Arrow keys nudge the selected layer; Shift makes the step ten times larger.
  const x = await numberIn(field(page, 'X position'));
  await page.getByTestId('layer-row').first().focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(() => numberIn(field(page, 'X position'))).toBeCloseTo(x + 11, 3);

  // Duplicate and delete from the keyboard.
  await page.keyboard.press('ControlOrMeta+d');
  await expect(page.getByTestId('layer-row')).toHaveCount(2);
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('layer-row')).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('layer-row')).toHaveCount(2);

  // Delete inside a number field edits the number; the layer stays.
  await page.getByTestId('layer-row').first().click();
  await field(page, 'X position').click();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('layer-row')).toHaveCount(2);
});

/** Read one pixel of an encoded image by decoding it in the page. */
async function pixelOf(page: Page, bytes: Buffer, mime: string, x: number, y: number): Promise<number[]> {
  return page.evaluate(
    async ([base64, type, px, py]) => {
      const data = Uint8Array.from(atob(base64 as string), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([data], { type: type as string }));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const g = canvas.getContext('2d')!;
      g.drawImage(bitmap, 0, 0);
      return Array.from(g.getImageData(px as number, py as number, 1, 1).data);
    },
    [bytes.toString('base64'), mime, x, y] as const,
  );
}

test('several layers move and resize together as one step each', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto('/');
  await page.getByTestId('new-thumbnail-720').click();
  await addPhoto(page, await makePhoto(page));
  await addHeadline(page);
  const layers = page.getByTestId('layer-row');
  await expect(layers).toHaveCount(2);
  const textSize = page.getByLabel('Text size');
  await expect(textSize).toHaveValue('144');
  const steps = await historyLength(page);
  const zoom = await zoomOf(page);

  // Select everything and drag: both layers move by the same amount.
  await layers.first().focus();
  await page.keyboard.press('ControlOrMeta+a');
  const grab = await pageToScreen(page, 230, 60);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + 40, grab.y + 25, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => historyLength(page)).toBe(steps + 1);

  await layers.nth(1).click();
  await expect.poll(() => numberIn(field(page, 'X position'))).toBeCloseTo(208 + 40 / zoom, 0);
  await expect(field(page, 'Width')).toHaveValue('864');
  await layers.first().click();
  await expect.poll(() => numberIn(field(page, 'X position'))).toBeCloseTo(192 + 40 / zoom, 0);
  await expect(textSize).toHaveValue('144');

  // Undo puts both back in a single step.
  await page.getByTestId('undo-button').click();
  await layers.nth(1).click();
  await expect(field(page, 'X position')).toHaveValue('208');

  // Resize the pair from the bottom-right corner: both scale by the same factor.
  await layers.first().focus();
  await page.keyboard.press('ControlOrMeta+a');
  // The selection box runs to the right edge of the headline (896 wide plus half its 22 px outline).
  const corner = await pageToScreen(page, 192 + 896 + 11, 36 + 648);
  await page.mouse.move(corner.x, corner.y);
  await page.mouse.down();
  await page.mouse.move(corner.x - 60, corner.y - 45, { steps: 8 });
  await page.mouse.move(corner.x - 120, corner.y - 90, { steps: 8 });
  await page.mouse.up();
  await layers.nth(1).click();
  const photoWidth = await numberIn(field(page, 'Width'));
  const photoHeight = await numberIn(field(page, 'Height'));
  expect(photoWidth).toBeLessThan(820);
  expect(photoWidth / photoHeight).toBeCloseTo(864 / 648, 2);
  await layers.first().click();
  const factor = photoWidth / 864;
  await expect.poll(() => numberIn(textSize)).toBeCloseTo(144 * factor, 0);
  expect(await historyLength(page)).toBe(steps + 1);
  expect(errors).toEqual([]);
});

test('transparency survives in PNG and is flattened in JPG', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('new-thumbnail-720').click();
  await page.getByTestId('rail-page').click();
  await page.getByLabel('Transparent background').check();
  await addHeadline(page);
  await expect(page.getByTestId('layer-row')).toHaveCount(1);

  const png = await exportThroughDialog(page);
  expect(pngSize(png)).toEqual({ width: 1280, height: 720 });
  const corner = await pixelOf(page, png, 'image/png', 4, 4);
  expect(corner[3]).toBe(0);
  // The middle of the headline is opaque.
  const text = await pixelOf(page, png, 'image/png', 640, 350);
  expect(text[3]).toBe(255);

  const jpeg = await exportThroughDialog(page, { format: 'JPG' });
  const flattened = await pixelOf(page, jpeg, 'image/jpeg', 4, 4);
  expect(flattened[3]).toBe(255);
  expect(Math.min(flattened[0]!, flattened[1]!, flattened[2]!)).toBeGreaterThan(245);
});

test('a missing image is reported, shown as a placeholder, and never left out silently', async ({ page, browser }) => {
  await page.goto('/');
  await page.getByTestId('new-thumbnail-720').click();
  await addPhoto(page, await makePhoto(page));
  await addHeadline(page);
  await expect(page.getByTestId('layer-row')).toHaveCount(2);
  const saving = page.waitForEvent('download');
  await page.getByTestId('save-button').click();
  const project = await readDownload(await saving);

  // Take the original image out of the project file.
  const entries = unzipSync(new Uint8Array(project));
  const assetPaths = Object.keys(entries).filter((name) => name.startsWith('assets/'));
  expect(assetPaths).toHaveLength(1);
  delete entries[assetPaths[0]!];
  expect(JSON.parse(strFromU8(entries['manifest.json']!)).format).toBe('fvs-design-project');
  const damaged = Buffer.from(zipSync(entries));

  // Open it somewhere that has never seen the image.
  const context = await browser.newContext({ acceptDownloads: true });
  const other = await context.newPage();
  await useBasicFileAccess(other);
  await other.goto('/');
  const opening = other.waitForEvent('filechooser');
  await other.getByTestId('open-project').click();
  await (await opening).setFiles({ name: 'damaged.fvsdesign', mimeType: 'application/octet-stream', buffer: damaged });
  await expect(other.getByTestId('editor')).toBeVisible();
  await expect(other.getByTestId('layer-row')).toHaveCount(2);
  await expect(other.getByTestId('warnings')).toContainText('One image is missing');

  // Export stops and says why; it only goes ahead when asked to.
  await other.getByTestId('export-button').click();
  await other.getByTestId('export-confirm').click();
  const dialog = other.getByTestId('export-dialog');
  await expect(dialog.getByRole('alert')).toContainText('missing');
  const download = other.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export anyway' }).click();
  expect(pngSize(await readDownload(await download))).toEqual({ width: 1280, height: 720 });
  await expect(dialog).toContainText('Missing images were left as placeholders');
  await context.close();
});

test('when autosave fails it says so, and saving a project file still works', async ({ page }) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'projects') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      return put.apply(this, args);
    };
  });
  await page.goto('/');
  await page.getByTestId('new-thumbnail-720').click();
  await addHeadline(page);
  const status = page.getByTestId('save-status');
  await expect(status).toHaveAttribute('data-state', 'failed');
  await expect(status).toContainText('Save a project file');

  const saving = page.waitForEvent('download');
  await page.getByTestId('save-button').click();
  const project = await readDownload(await saving);
  expect(project.subarray(0, 2).toString()).toBe('PK');
  await expect(page.getByTestId('toast')).toContainText('Downloaded');
});

test('dragging a slider is one undo step, however far it is dragged', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('new-thumbnail-720').click();
  await addHeadline(page);
  await expect(page.getByTestId('layer-row')).toHaveCount(1);
  const steps = await historyLength(page);

  const slider = page.getByRole('slider', { name: 'Opacity' });
  const box = (await slider.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.9, y);
  await page.mouse.down();
  for (const at of [0.8, 0.7, 0.6, 0.5, 0.4]) await page.mouse.move(box.x + box.width * at, y, { steps: 3 });
  await page.mouse.up();

  const opacity = await numberIn(field(page, 'Opacity'));
  expect(opacity).toBeGreaterThan(30);
  expect(opacity).toBeLessThan(50);
  expect(await historyLength(page)).toBe(steps + 1);
  await page.getByTestId('undo-button').click();
  await expect(field(page, 'Opacity')).toHaveValue('100');
});

test('opening the same design in a second tab warns about it', async ({ page, context }) => {
  await page.goto('/');
  await page.getByTestId('new-thumbnail-720').click();
  await addHeadline(page);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'autosaved');
  await expect(page.getByTestId('warnings')).toHaveCount(0);

  const second = await context.newPage();
  await second.goto('/');
  await second.getByTestId('recent-project').click();
  await expect(second.getByTestId('editor')).toBeVisible();
  await expect(second.getByTestId('warnings')).toContainText('also open in another tab or window');
  // The first tab, which had it first, is not disturbed.
  await expect(page.getByTestId('warnings')).toHaveCount(0);
});
