import { expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDownload } from './helpers';

/**
 * A stand-in for the photo-enlarging model, so tests never download the real one.
 * It is a real ONNX model that repeats every pixel 4 x 4 times, which makes the
 * result exactly predictable. See tests/fixtures/make-nearest-x4-stub.py.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const STUB_MODEL = readFileSync(path.join(ROOT, 'tests', 'fixtures', 'nearest-x4-stub.onnx'));
export const STUB_MODEL_URL = `https://huggingface.co/fvs-tests/stub/resolve/${'0'.repeat(40)}/nearest-x4-stub.onnx`;
export const STUB_SOURCES = [{ url: STUB_MODEL_URL, bytes: STUB_MODEL.length, sha256: createHash('sha256').update(STUB_MODEL).digest('hex') }];
export const HUGGING_FACE = /^https:\/\/([\w.-]+\.)?(huggingface\.co|hf\.co)\//;

/** Tell the app (before it starts) to use the stand-in model's address and hash. */
export async function pointAtStubModel(page: Page): Promise<void> {
  await page.addInitScript((sources) => {
    (globalThis as { __FVS_TEST_UPSCALE_SOURCES__?: unknown }).__FVS_TEST_UPSCALE_SOURCES__ = sources;
  }, STUB_SOURCES);
}

/** Answer the stand-in model's address. Returns the list of requests made for it. */
export async function serveStubModel(page: Page, options: { hold?: Promise<void> } = {}): Promise<string[]> {
  const requests: string[] = [];
  await page.route(STUB_MODEL_URL, async (route) => {
    requests.push(route.request().url());
    await options.hold;
    await route.fulfill({ status: 200, contentType: 'application/octet-stream', headers: { 'access-control-allow-origin': '*' }, body: STUB_MODEL });
  });
  return requests;
}

/** Export through the dialog, returning the file and any notes the dialog showed. */
export async function exportWithNotes(page: Page, size = '3840 × 2160'): Promise<{ bytes: Buffer; notes: string }> {
  await page.getByTestId('export-button').click();
  const dialog = page.getByTestId('export-dialog');
  await dialog.getByRole('button', { name: size }).click();
  const download = page.waitForEvent('download');
  await page.getByTestId('export-confirm').click();
  const bytes = await readDownload(await download);
  // With notes the dialog stays open and its button says Done; without, it closes itself.
  const done = dialog.getByRole('button', { name: 'Done' });
  await expect(async () => expect((await dialog.isHidden()) || (await done.isVisible())).toBe(true)).toPass();
  let notes = '';
  if (await dialog.isVisible()) {
    notes = (await dialog.getByRole('status').textContent().catch(() => '')) ?? '';
    await done.click();
  }
  await expect(dialog).toBeHidden();
  return { bytes, notes };
}

export async function openUpscale(page: Page) {
  await page.getByTestId('upscale-button').click();
  const dialog = page.getByTestId('upscale-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}
