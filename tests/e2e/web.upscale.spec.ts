import { expect, test, type Browser, type Page } from '@playwright/test';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import { addPhoto, field, historyLength, makePhoto, openProjectFile, saveProjectFile, setField, useBasicFileAccess } from './helpers';
import { exportWithNotes, HUGGING_FACE, openUpscale, pointAtStubModel, serveStubModel } from './upscaleHelpers';

/**
 * Upscaling a photo: the whole flow in the browser, with a stand-in model.
 *
 * The stand-in is a real ONNX model run by the real runtime in the real worker;
 * it just repeats pixels instead of inventing detail, so results are exact. The
 * real model is never downloaded here.
 */

test.beforeEach(async ({ page }) => {
  await useBasicFileAccess(page);
  await pointAtStubModel(page);
});

/** A 640 x 360 photo stretched to fill a 1280 x 720 page: soft on the page, and very soft at 4K. */
async function softPhoto(page: Page): Promise<Buffer> {
  await page.goto('/');
  await page.getByTestId('new-thumbnail-720').click();
  const photo = await makePhoto(page, 640, 360);
  await addPhoto(page, photo);
  await expect(page.getByTestId('layer-row')).toHaveCount(1);
  await setField(field(page, 'Width'), 1280);
  await expect(field(page, 'Height')).toHaveValue('720');
  await setField(field(page, 'X position'), 0);
  await setField(field(page, 'Y position'), 0);
  return photo;
}

async function elsewhere(browser: Browser): Promise<{ page: Page; requests: string[]; close(): Promise<void> }> {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await useBasicFileAccess(page);
  await pointAtStubModel(page);
  // No way to reach the model's host at all.
  const requests: string[] = [];
  await page.route(HUGGING_FACE, (route) => {
    requests.push(route.request().url());
    return route.abort('internetdisconnected');
  });
  await page.goto('/');
  return { page, requests, close: () => context.close() };
}

function readProject(project: Buffer) {
  const entries = unzipSync(new Uint8Array(project));
  const document = JSON.parse(strFromU8(entries['document.json']!)) as {
    schemaVersion: number;
    pages: { nodes: { type: string; assetId: string; upscale: { assetId: string; method: string; factor: number } | null }[] }[];
    assets: Record<string, { width: number; height: number; mime: string; derivedFrom?: { assetId: string; method: string; factor: number } }>;
  };
  return { entries, document, assetPaths: Object.keys(entries).filter((name) => name.startsWith('assets/')) };
}

test('upscale a photo, compare, keep it, undo, save, reopen and export identically', async ({ page, browser }) => {
  const model = await serveStubModel(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  const photo = await softPhoto(page);
  const button = page.getByTestId('upscale-button');

  // The control stands out because the photo is stretched on this page.
  await expect(button).toHaveText('Upscale');
  await expect(button).toHaveAttribute('data-soft', 'true');
  await expect(page.getByTestId('context-bar')).toContainText('Looks soft at this size');

  // Export says so too, and points at the fix.
  const before = await exportWithNotes(page);
  expect(before.notes).toContain('stretched to 600% of its original resolution');
  expect(before.notes).toContain('Upscale the photo to sharpen it');
  const steps = await historyLength(page);

  // ---- the dialog explains the situation and suggests the enlargement that fixes it
  const dialog = await openUpscale(page);
  await expect(page.getByTestId('upscale-situation')).toContainText('The photo is 640 × 360 pixels');
  await expect(page.getByTestId('upscale-situation')).toContainText('stretched to 600%');
  await expect(page.getByTestId('upscale-factor-4')).toBeChecked();
  await expect(dialog).toContainText('2560 × 1440 pixels');
  // The one-time download is announced before it happens, and has not happened yet.
  await expect(page.getByTestId('upscale-download-note')).toContainText('downloaded from huggingface.co');
  expect(model).toHaveLength(0);

  // ---- run it: the result is shown beside the original, and nothing has changed yet
  await page.getByTestId('upscale-start').click();
  await expect(page.getByTestId('upscale-compare')).toBeVisible({ timeout: 60_000 });
  await expect(dialog).toContainText('Now 2560 × 1440 pixels, up from 640 × 360');
  expect(model).toHaveLength(1);
  const slider = page.getByTestId('upscale-compare-slider');
  await slider.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(slider).toHaveValue('49');
  expect(await historyLength(page)).toBe(steps);

  // ---- discard: back to the choices, still nothing changed
  await page.getByTestId('upscale-discard').click();
  await expect(page.getByTestId('upscale-start')).toBeVisible();
  await expect(page.getByTestId('upscale-download-note')).toHaveCount(0);

  // ---- run again and keep it: the model is not downloaded a second time
  await page.getByTestId('upscale-start').click();
  await expect(page.getByTestId('upscale-compare')).toBeVisible({ timeout: 60_000 });
  expect(model).toHaveLength(1);
  await page.getByTestId('upscale-keep').click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('toast')).toContainText('Photo enlarged 4 times. The original is kept');
  await expect(button).toHaveText('Upscaled 4×');
  await expect(button).toHaveAttribute('data-soft', 'false');
  await expect(page.getByTestId('context-bar')).not.toContainText('Looks soft');
  // One undo step, and the layer's place and size are untouched.
  expect(await historyLength(page)).toBe(steps + 1);
  await expect(field(page, 'Width')).toHaveValue('1280');
  await expect(field(page, 'X position')).toHaveValue('0');

  // ---- export now uses the enlarged pixels, and no longer complains
  const after = await exportWithNotes(page);
  expect(after.notes).toBe('');
  expect(after.bytes.equals(before.bytes)).toBe(false);

  // ---- undo and redo
  await page.getByTestId('undo-button').click();
  await expect(button).toHaveText('Upscale');
  expect((await exportWithNotes(page)).bytes.equals(before.bytes)).toBe(true);
  await page.getByTestId('redo-button').click();
  await expect(button).toHaveText('Upscaled 4×');
  expect((await exportWithNotes(page)).bytes.equals(after.bytes)).toBe(true);

  // ---- the project keeps the original AND the enlarged copy, and records how it was made
  const project = await saveProjectFile(page);
  const saved = readProject(project);
  expect(saved.document.schemaVersion).toBe(3);
  expect(saved.assetPaths).toHaveLength(2);
  expect(project.includes(photo)).toBe(true);
  const layer = saved.document.pages[0]!.nodes[0]!;
  expect(layer.upscale).toMatchObject({ method: 'realesr-general-x4v3', factor: 4 });
  expect(layer.upscale!.assetId).not.toBe(layer.assetId);
  expect(saved.document.assets[layer.assetId]).toMatchObject({ width: 640, height: 360 });
  expect(saved.document.assets[layer.upscale!.assetId]).toMatchObject({
    width: 2560,
    height: 1440,
    mime: 'image/png',
    derivedFrom: { assetId: layer.assetId, method: 'realesr-general-x4v3', factor: 4 },
  });

  // The stand-in model repeats pixels, so the enlarged copy must be exactly the original with each pixel 4 x 4.
  const enlargedPath = saved.assetPaths.find((name) => name.includes(layer.upscale!.assetId))!;
  const exact = await page.evaluate(
    async ([originalBase64, enlargedBase64]) => {
      const pixels = async (base64: string, scale: number) => {
        const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: 'image/png' }));
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width * scale;
        canvas.height = bitmap.height * scale;
        const context = canvas.getContext('2d')!;
        context.imageSmoothingEnabled = false;
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        return context.getImageData(0, 0, canvas.width, canvas.height).data;
      };
      const [expected, actual] = await Promise.all([pixels(originalBase64!, 4), pixels(enlargedBase64!, 1)]);
      if (expected.length !== actual.length) return `different sizes: ${expected.length} and ${actual.length}`;
      for (let i = 0; i < expected.length; i++) if (expected[i] !== actual[i]) return `first difference at byte ${i}: ${expected[i]} and ${actual[i]}`;
      return 'identical';
    },
    [photo.toString('base64'), Buffer.from(saved.entries[enlargedPath]!).toString('base64')],
  );
  expect(exact).toBe('identical');

  // ---- reopen somewhere with empty storage and no access to the model: nothing is recomputed
  const other = await elsewhere(browser);
  await openProjectFile(other.page, project);
  await expect(other.page.getByTestId('layer-row')).toHaveCount(1);
  await expect(other.page.getByTestId('warnings')).toHaveCount(0);
  await other.page.getByTestId('layer-row').first().click();
  await expect(other.page.getByTestId('upscale-button')).toHaveText('Upscaled 4×');
  expect((await exportWithNotes(other.page)).bytes.equals(after.bytes)).toBe(true);

  // ---- turning it off there gives back exactly the original
  const otherDialog = await openUpscale(other.page);
  await expect(other.page.getByTestId('upscale-situation')).toContainText('already enlarged 4 times');
  // 640 pixels enlarged 4 times is 2560: a little short of 4K, and the dialog says so without alarm.
  await expect(other.page.getByTestId('upscale-situation')).toContainText('stretched to 150% of its size, which usually still looks fine');
  await other.page.getByTestId('upscale-off').click();
  await expect(otherDialog).toBeHidden();
  await expect(other.page.getByTestId('upscale-button')).toHaveText('Upscale');
  expect((await exportWithNotes(other.page)).bytes.equals(before.bytes)).toBe(true);
  await other.page.getByTestId('undo-button').click();
  await expect(other.page.getByTestId('upscale-button')).toHaveText('Upscaled 4×');
  expect(other.requests).toEqual([]);
  await other.close();

  // ---- if the enlarged copy goes missing, the original is shown and that is said out loud
  const { [enlargedPath]: _removed, ...rest } = saved.entries;
  const third = await elsewhere(browser);
  await openProjectFile(third.page, Buffer.from(zipSync(rest)));
  await expect(third.page.getByTestId('warnings')).toContainText('The enlarged copy of');
  await expect(third.page.getByTestId('warnings')).toContainText('the original is shown');
  const lost = await exportWithNotes(third.page);
  expect(lost.notes).toContain('is missing, so its original was used');
  expect(lost.bytes.equals(before.bytes)).toBe(true);
  await third.close();

  expect(errors).toEqual([]);
});

test('cancelling changes nothing, and with no connection a plain resize is offered and labelled honestly', async ({ page }) => {
  // ---- cancel while the helper is downloading
  let release = () => undefined as void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const slowModel = await serveStubModel(page, { hold: held });
  await softPhoto(page);
  const steps = await historyLength(page);
  const dialog = await openUpscale(page);
  await page.getByTestId('upscale-start').click();
  await expect(page.getByTestId('upscale-progress')).toContainText('Downloading the helper');
  await page.getByTestId('upscale-cancel').click();
  await expect(page.getByTestId('upscale-start')).toBeVisible();
  await expect(page.getByTestId('upscale-problem')).toHaveCount(0);
  release();
  expect(slowModel).toHaveLength(1);

  // ---- no connection: say why, and offer the plain resize
  await page.unroute(/.*/);
  await page.route(HUGGING_FACE, (route) => route.abort('internetdisconnected'));
  await page.getByTestId('upscale-start').click();
  const problem = page.getByTestId('upscale-problem');
  await expect(problem).toContainText('The enlarging helper could not be downloaded');
  await expect(problem).toContainText('Check your internet connection');
  await expect(problem).toContainText('adds no new detail');
  expect(await historyLength(page)).toBe(steps);
  await page.getByTestId('upscale-plain').click();
  await expect(page.getByTestId('upscale-compare')).toBeVisible({ timeout: 60_000 });
  await expect(dialog).toContainText('This is a plain resize: smoother, but with no new detail');
  await page.getByTestId('upscale-keep').click();
  await expect(page.getByTestId('upscale-button')).toHaveText('Upscaled 4×');
  expect(await historyLength(page)).toBe(steps + 1);
  // It stays labelled as what it is.
  await openUpscale(page);
  await expect(page.getByTestId('upscale-situation')).toContainText('already enlarged 4 times (plain resize)');
  await page.getByTestId('upscale-off').click();
  await expect(page.getByTestId('upscale-button')).toHaveText('Upscale');

  // ---- cancel while the work itself is starting up: the worker is stopped, nothing is left behind
  await page.unroute(/.*/);
  await serveStubModel(page);
  let releaseRuntime = () => undefined as void;
  const runtimeHeld = new Promise<void>((resolve) => (releaseRuntime = resolve));
  await page.route('**/*.wasm', async (route) => {
    await runtimeHeld;
    await route.continue();
  });
  const stepsNow = await historyLength(page);
  await openUpscale(page);
  await page.getByTestId('upscale-start').click();
  await expect(page.getByTestId('upscale-progress')).toContainText(/Getting ready|Enlarging/);
  await page.getByTestId('upscale-cancel').click();
  await expect(page.getByTestId('upscale-start')).toBeVisible();
  await expect(page.getByTestId('upscale-problem')).toHaveCount(0);
  releaseRuntime();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('upscale-button')).toHaveText('Upscale');
  expect(await historyLength(page)).toBe(stepsNow);
  await expect(page.getByTestId('warnings')).toHaveCount(0);
});

test('an enlargement that would be too large is not offered', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('new-thumbnail-720').click();
  await addPhoto(page, await makePhoto(page, 2600, 1500));
  await expect(page.getByTestId('layer-row')).toHaveCount(1);
  const dialog = await openUpscale(page);
  // 4 times would be 10400 pixels wide, beyond what is attempted. 2 times is fine and is what is suggested.
  await expect(page.getByTestId('upscale-factor-4')).toBeDisabled();
  await expect(dialog).toContainText('Too large for this photo');
  await expect(page.getByTestId('upscale-factor-2')).toBeChecked();
  await expect(dialog).toContainText('5200 × 3000 pixels');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
