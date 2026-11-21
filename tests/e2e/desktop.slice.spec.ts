import { expect, test } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { answer, exportPng, launch, saveDialogCount } from './desktopHelpers';
import { addHeadline, field, makePhoto, pngSize, setField } from './helpers';

/**
 * The same vertical slice inside the desktop shell, using real files on disk:
 * add a photo and text -> export -> save project -> quit -> start again with
 * empty app storage -> open the project file -> export again -> identical image.
 */

test('desktop: edit, export, save, quit, reopen from the file and export identically', async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'fvs-desktop-'));
  const projectPath = path.join(work, 'My thumbnail.fvsdesign');
  const external: string[] = [];

  // ---------------------------------------------------------- first run
  let { app, page } = await launch(path.join(work, 'profile-1'));
  page.on('request', (request) => {
    if (!request.url().startsWith('app://editor/') && !request.url().startsWith('data:') && !request.url().startsWith('blob:')) {
      external.push(request.url());
    }
  });
  const environment = await page.evaluate(() => ({
    bridge: typeof window.fvsDesktop?.saveProject,
    origin: location.origin,
    secure: isSecureContext,
    node: typeof (globalThis as { require?: unknown }).require,
  }));
  // The page gets the file bridge and nothing else from Node.
  expect(environment).toEqual({ bridge: 'function', origin: 'app://editor', secure: true, node: 'undefined' });

  await page.getByTestId('new-thumbnail-720').click();
  await expect(page.getByTestId('editor')).toBeVisible();

  // Drop a photo onto the canvas.
  const photo = await makePhoto(page);
  await page.evaluate((base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'photo.png', { type: 'image/png' }));
    const target = document.querySelector('[data-testid="canvas-host"]')!.parentElement!;
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  }, photo.toString('base64'));
  const layers = page.getByTestId('layer-row');
  await expect(layers).toHaveCount(1);
  await setField(field(page, 'Rotation'), -12);
  await setField(field(page, 'Width'), 700);

  await addHeadline(page);
  await expect(layers).toHaveCount(2);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('context-bar')).toHaveAttribute('data-editing-text', 'true');
  await page.keyboard.type('Desktop round trip, second line wraps here');
  await page.keyboard.press('Escape');
  await expect(layers.first()).toContainText('Desktop round trip');

  const exportA = await exportPng(app, page, path.join(work, 'before.png'));
  expect(pngSize(exportA)).toEqual({ width: 3840, height: 2160 });

  // Save: the first save asks where, and writes a complete zip with the original photo inside.
  await answer(app, { savePath: projectPath });
  await page.getByTestId('save-button').click();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  const firstSave = await fs.readFile(projectPath);
  expect(firstSave.subarray(0, 2).toString()).toBe('PK');
  expect(firstSave.includes(photo)).toBe(true);
  const dialogsAfterFirstSave = await saveDialogCount(app);

  // Save again after a change: same file, no dialog, and no temporary files left behind.
  await answer(app, { savePath: path.join(work, 'should-not-be-used.fvsdesign') });
  await layers.first().click();
  await setField(field(page, 'Y position'), 300);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'autosaved');
  await page.getByTestId('save-button').click();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  expect(await saveDialogCount(app)).toBe(dialogsAfterFirstSave);
  expect((await fs.readFile(projectPath)).equals(firstSave)).toBe(false);
  expect((await fs.readdir(work)).filter((name) => name.endsWith('.tmp') || name.startsWith('should-not'))).toEqual([]);

  // A save that cannot be written reports the failure and leaves the good file untouched.
  const goodFile = await fs.readFile(projectPath);
  await answer(app, { savePath: path.join(work, 'no-such-folder', 'copy.fvsdesign') });
  await page.getByRole('button', { name: 'Save as…' }).click();
  await expect(page.getByTestId('toast')).toContainText('could not be saved');
  await expect(page.getByTestId('toast')).toHaveAttribute('data-kind', 'error');
  expect((await fs.readFile(projectPath)).equals(goodFile)).toBe(true);
  expect((await fs.readdir(work)).filter((name) => name.endsWith('.tmp'))).toEqual([]);

  const exportB = await exportPng(app, page, path.join(work, 'after-move.png'));
  expect(exportB.equals(exportA)).toBe(false);
  expect(external).toEqual([]);
  await app.close();

  // --------------------------------- second run, with empty app storage
  ({ app, page } = await launch(path.join(work, 'profile-2')));
  await expect(page.getByTestId('recent-project')).toHaveCount(0);
  await answer(app, { openPath: projectPath });
  await page.getByTestId('open-project').click();
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('layer-row')).toHaveCount(2);
  await expect(page.getByTestId('warnings')).toHaveCount(0);
  await expect(page.getByLabel('Design name')).toHaveValue('Untitled design');

  // The project file alone reproduces the design exactly.
  const exportC = await exportPng(app, page, path.join(work, 'reopened.png'));
  expect(exportC.equals(exportB)).toBe(true);
  await app.close();

  await fs.rm(work, { recursive: true, force: true });
});
