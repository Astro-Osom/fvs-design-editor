import { expect, test } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { answer, exportPng, launch } from './desktopHelpers';
import { field, makePhoto, setField } from './helpers';
import { HUGGING_FACE, STUB_MODEL, STUB_MODEL_URL, STUB_SOURCES } from './upscaleHelpers';

/**
 * Upscaling in the desktop app: the security policy lets the model download and
 * the WebAssembly runtime start, the work runs in a worker, and the enlarged
 * photo reopens from the project file alone. Uses the stand-in model.
 */
test('desktop: upscale a photo, save, quit, reopen with no network and export identically', async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'fvs-desktop-upscale-'));
  const projectPath = path.join(work, 'Upscaled.fvsdesign');

  let { app, page } = await launch(path.join(work, 'profile-1'));
  const violations: string[] = [];
  const errors: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  const modelRequests: string[] = [];
  await app.context().route(STUB_MODEL_URL, (route) => {
    modelRequests.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/octet-stream', headers: { 'access-control-allow-origin': '*' }, body: STUB_MODEL });
  });
  await page.evaluate((sources) => {
    (globalThis as { __FVS_TEST_UPSCALE_SOURCES__?: unknown }).__FVS_TEST_UPSCALE_SOURCES__ = sources;
  }, STUB_SOURCES);

  await page.getByTestId('new-thumbnail-720').click();
  const photo = await makePhoto(page, 640, 360);
  await page.evaluate((base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'photo.png', { type: 'image/png' }));
    document.querySelector('[data-testid="canvas-host"]')!.parentElement!.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  }, photo.toString('base64'));
  await expect(page.getByTestId('layer-row')).toHaveCount(1);
  await setField(field(page, 'Width'), 1280);
  await setField(field(page, 'X position'), 0);
  await setField(field(page, 'Y position'), 0);
  const before = await exportPng(app, page, path.join(work, 'before.png'));

  await page.getByTestId('upscale-button').click();
  await page.getByTestId('upscale-start').click();
  await expect(page.getByTestId('upscale-compare')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('upscale-keep').click();
  await expect(page.getByTestId('upscale-button')).toHaveText('Upscaled 4×');
  expect(modelRequests).toHaveLength(1);
  expect(violations).toEqual([]);

  const after = await exportPng(app, page, path.join(work, 'after.png'));
  expect(after.equals(before)).toBe(false);

  await answer(app, { savePath: projectPath });
  await page.getByTestId('save-button').click();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  expect((await fs.readFile(projectPath)).includes(photo)).toBe(true);
  expect(errors).toEqual([]);
  await app.close();

  // Second run: empty app storage, and the model's host cannot be reached.
  ({ app, page } = await launch(path.join(work, 'profile-2')));
  const later: string[] = [];
  await app.context().route(HUGGING_FACE, (route) => {
    later.push(route.request().url());
    return route.abort('internetdisconnected');
  });
  await answer(app, { openPath: projectPath });
  await page.getByTestId('open-project').click();
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('layer-row')).toHaveCount(1);
  await expect(page.getByTestId('warnings')).toHaveCount(0);
  await page.getByTestId('layer-row').first().click();
  await expect(page.getByTestId('upscale-button')).toHaveText('Upscaled 4×');
  const reopened = await exportPng(app, page, path.join(work, 'reopened.png'));
  expect(reopened.equals(after)).toBe(true);
  expect(later).toEqual([]);
  await app.close();

  await fs.rm(work, { recursive: true, force: true });
});
