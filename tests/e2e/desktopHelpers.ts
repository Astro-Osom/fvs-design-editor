import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Shared helpers for tests that drive the desktop app. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: ROOT });
  // Native dialogs cannot be driven by a test, so they are answered here with chosen paths.
  await app.evaluate(({ dialog }) => {
    const answers = globalThis as unknown as { savePath?: string; openPath?: string; saveDialogs: number };
    answers.saveDialogs = 0;
    dialog.showSaveDialog = (async () => {
      answers.saveDialogs++;
      return { canceled: false, filePath: answers.savePath };
    }) as unknown as typeof dialog.showSaveDialog;
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [answers.openPath] })) as unknown as typeof dialog.showOpenDialog;
  });
  const page = await app.firstWindow();
  await expect(page.getByTestId('start-screen')).toBeVisible();
  return { app, page };
}

export const answer = (app: ElectronApplication, values: { savePath?: string; openPath?: string }) =>
  app.evaluate((_, v) => Object.assign(globalThis, v), values);

export const saveDialogCount = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { saveDialogs: number }).saveDialogs);

export async function exportPng(app: ElectronApplication, page: Page, target: string): Promise<Buffer> {
  await answer(app, { savePath: target });
  await page.getByTestId('export-button').click();
  const dialog = page.getByTestId('export-dialog');
  await dialog.getByRole('button', { name: '3840 × 2160' }).click();
  await page.getByTestId('export-confirm').click();
  await expect(dialog).toBeHidden();
  return fs.readFile(target);
}
