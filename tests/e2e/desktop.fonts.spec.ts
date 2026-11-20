import { expect, test, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fontsourceFile } from '../support/fontFixtures';
import { answer, exportPng, launch } from './desktopHelpers';
import { addHeadline, fontOption, openFontList } from './helpers';

/**
 * Fonts in the desktop app: the security policy allows downloading from Google
 * Fonts and nothing else, the app may list installed fonts and has no other
 * browser permission, and a project with a downloaded font reopens from the file
 * alone.
 *
 * Google is not contacted: its two hosts are answered inside the app with openly
 * licensed font files from node_modules.
 */

const GOOGLE = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;

async function headline(page: Page, text: string): Promise<void> {
  await page.getByTestId('new-thumbnail-720').click();
  await addHeadline(page);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('context-bar')).toHaveAttribute('data-editing-text', 'true');
  await page.keyboard.type(text);
  await page.keyboard.press('Escape');
  await page.getByTestId('layer-row').first().click();
}

test('desktop: a Google font downloads under the security policy and reopens from the project file', async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'fvs-desktop-fonts-'));
  const projectPath = path.join(work, 'Fonts.fvsdesign');

  let { app, page } = await launch(path.join(work, 'profile-1'));
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text());
  });
  const requests: string[] = [];
  const elsewhere: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (GOOGLE.test(url)) requests.push(url);
    else if (!url.startsWith('app://editor/') && !url.startsWith('data:') && !url.startsWith('blob:')) elsewhere.push(url);
  });
  await app.context().route('https://fonts.googleapis.com/**', (route) => {
    const face = (file: string, range: string) =>
      `@font-face {\n  font-family: 'Lobster';\n  font-style: normal;\n  font-weight: 400;\n  src: url(https://fonts.gstatic.com/s/lobster/v1/${file}.woff2) format('woff2');\n  unicode-range: ${range};\n}\n`;
    return route.fulfill({
      status: 200,
      contentType: 'text/css; charset=utf-8',
      headers: { 'access-control-allow-origin': '*' },
      body: face('latin-ext', 'U+0100-02BA, U+1E00-1E9F') + face('latin', 'U+0000-00FF, U+0131, U+2000-206F'),
    });
  });
  await app.context().route('https://fonts.gstatic.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'font/woff2',
      headers: { 'access-control-allow-origin': '*' },
      body: Buffer.from(fontsourceFile('lobster', route.request().url().includes('latin-ext') ? 'lobster-latin-ext-400-normal.woff2' : 'lobster-latin-400-normal.woff2')),
    }),
  );

  // The app may list installed fonts. Every other browser permission is refused.
  const permissions = await page.evaluate(async () => {
    const state = async (name: string) => {
      try {
        return (await navigator.permissions.query({ name: name as PermissionName })).state;
      } catch {
        return 'unknown';
      }
    };
    return { fonts: await state('local-fonts'), location: await state('geolocation'), camera: await state('camera'), notifications: await state('notifications') };
  });
  expect(permissions).toEqual({ fonts: 'granted', location: 'denied', camera: 'denied', notifications: 'denied' });
  // Anything other than Google's two font hosts is blocked by the security policy.
  const blocked = await page.evaluate(() =>
    fetch('https://example.com/', { mode: 'no-cors' }).then(
      () => 'allowed',
      () => 'blocked',
    ),
  );
  expect(blocked).toBe('blocked');
  violations.length = 0;

  await headline(page, 'Desktop fonts in Łódź');
  const inAnton = await exportPng(app, page, path.join(work, 'anton.png'));

  await openFontList(page);
  await page.getByTestId('font-search').fill('lobster');
  expect(requests).toEqual([]);
  await fontOption(page, 'Lobster', 'google').click();
  await expect(page.getByTestId('font-button')).toHaveAttribute('data-family', 'Lobster');
  await page.getByTestId('font-search').press('Escape');
  await expect(page.getByTestId('warnings')).toHaveCount(0);
  expect(requests.filter((url) => url.includes('googleapis'))).toHaveLength(1);
  expect(requests.filter((url) => url.includes('gstatic'))).toHaveLength(2);
  expect(violations).toEqual([]);

  const inLobster = await exportPng(app, page, path.join(work, 'lobster.png'));
  expect(inLobster.equals(inAnton)).toBe(false);

  await answer(app, { savePath: projectPath });
  await page.getByTestId('save-button').click();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  const saved = await fs.readFile(projectPath);
  expect(saved.includes(Buffer.from(fontsourceFile('lobster', 'lobster-latin-400-normal.woff2')))).toBe(true);
  expect(elsewhere).toEqual([]);
  await app.close();

  // Second run: empty app storage, and Google is unreachable.
  ({ app, page } = await launch(path.join(work, 'profile-2')));
  const later: string[] = [];
  await app.context().route(GOOGLE, (route) => {
    later.push(route.request().url());
    return route.abort('internetdisconnected');
  });
  await answer(app, { openPath: projectPath });
  await page.getByTestId('open-project').click();
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('layer-row')).toHaveCount(1);
  await expect(page.getByTestId('warnings')).toHaveCount(0);
  const reopened = await exportPng(app, page, path.join(work, 'reopened.png'));
  expect(reopened.equals(inLobster)).toBe(true);
  expect(later).toEqual([]);
  await app.close();

  await fs.rm(work, { recursive: true, force: true });
});

test('desktop: fonts installed on the computer are listed and can be used', async () => {
  test.setTimeout(300_000);
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'fvs-desktop-installed-'));
  const { app, page } = await launch(path.join(work, 'profile'));
  await headline(page, 'Installed');

  await openFontList(page);
  await page.getByTestId('font-filter-installed').click();
  // Choosing "This computer" asks for the list. No permission question is shown in the desktop app;
  // the first listing can take half a minute.
  const installed = page.locator('[data-testid="font-option"][data-group="installed"]');
  await expect(installed.first().or(page.getByTestId('font-list').getByText(/not allowed|Not possible/))).toBeVisible({ timeout: 150_000 });
  test.skip((await installed.count()) === 0, 'This machine has no installed fonts to list.');

  const family = (await installed.first().getAttribute('data-family'))!;
  await installed.first().click();
  await expect(page.getByTestId('font-button')).toHaveAttribute('data-family', family);
  await expect(page.getByTestId('toast')).toContainText(`${family} is on this computer`);
  await page.getByTestId('font-search').press('Escape');
  await expect(page.getByTestId('warnings')).toHaveCount(0);
  const exported = await exportPng(app, page, path.join(work, 'installed.png'));
  expect(exported.length).toBeGreaterThan(1000);

  await app.close();
  await fs.rm(work, { recursive: true, force: true });
});
