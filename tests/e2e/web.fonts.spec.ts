import { expect, test, type Browser, type Page } from '@playwright/test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { fontsourceFile, pacificoWoff, pacificoWoff2, woffToSfnt } from '../support/fontFixtures';
import {
  addHeadline,
  exportThroughDialog,
  fontOption,
  historyLength,
  openFontList,
  openProjectFile,
  pickFont,
  saveProjectFile,
  useBasicFileAccess,
} from './helpers';

/**
 * Fonts beyond the built-in ones: Google Fonts (downloaded on demand), font files
 * the person adds, and fonts installed on the computer.
 *
 * Google is never contacted by these tests: its two hosts are answered here with
 * openly licensed font files from node_modules.
 */

const GOOGLE = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;
const CORS = { 'access-control-allow-origin': '*' };

interface GoogleTraffic {
  stylesheets: string[];
  files: string[];
}

/** Stand in for Google Fonts. Every family is answered with Lobster's real files. */
async function mockGoogleFonts(page: Page, options: { holdFiles?: Promise<void> } = {}): Promise<GoogleTraffic> {
  const traffic: GoogleTraffic = { stylesheets: [], files: [] };
  await page.route('https://fonts.googleapis.com/**', async (route) => {
    const url = new URL(route.request().url());
    traffic.stylesheets.push(url.href);
    const family = (url.searchParams.get('family') ?? '').split(':')[0]!;
    const slug = family.toLowerCase().replace(/\s+/g, '');
    const face = (file: string, range: string) =>
      `@font-face {\n  font-family: '${family}';\n  font-style: normal;\n  font-weight: 400;\n  src: url(https://fonts.gstatic.com/s/${slug}/v1/${file}.woff2) format('woff2');\n  unicode-range: ${range};\n}\n`;
    const body = url.searchParams.has('text')
      ? face('sample', 'U+0000-00FF')
      : face('latin-ext', 'U+0100-02BA, U+1E00-1E9F') + face('latin', 'U+0000-00FF, U+0131, U+0152-0153, U+2000-206F');
    await route.fulfill({ status: 200, contentType: 'text/css; charset=utf-8', headers: CORS, body });
  });
  await page.route('https://fonts.gstatic.com/**', async (route) => {
    const url = route.request().url();
    traffic.files.push(url);
    await options.holdFiles;
    const file = url.includes('latin-ext') ? 'lobster-latin-ext-400-normal.woff2' : 'lobster-latin-400-normal.woff2';
    await route.fulfill({ status: 200, contentType: 'font/woff2', headers: CORS, body: Buffer.from(fontsourceFile('lobster', file)) });
  });
  return traffic;
}

async function freshComputer(browser: Browser, options: { permissions?: string[] } = {}): Promise<{ page: Page; google: string[]; close(): Promise<void> }> {
  const context = await browser.newContext({ acceptDownloads: true, permissions: options.permissions ?? [] });
  const page = await context.newPage();
  await useBasicFileAccess(page);
  // Somewhere with no connection to Google at all.
  const google: string[] = [];
  await page.route(GOOGLE, (route) => {
    google.push(route.request().url());
    return route.abort('internetdisconnected');
  });
  await page.goto('/');
  return { page, google, close: () => context.close() };
}

async function startWithHeadline(page: Page, text = 'Crème brûlée in Łódź'): Promise<void> {
  await page.goto('/');
  await page.getByTestId('new-thumbnail-720').click();
  await addHeadline(page);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('context-bar')).toHaveAttribute('data-editing-text', 'true');
  await page.keyboard.type(text);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('context-bar')).toHaveAttribute('data-editing-text', 'false');
  await page.getByTestId('layer-row').first().click();
  await expect(page.getByTestId('font-button')).toHaveAttribute('data-family', 'Anton');
}

async function addFontFile(page: Page, trigger: 'font-add-file' | 'missing-font-add-file', file: { name: string; bytes: Uint8Array }): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId(trigger).click();
  await (await chooser).setFiles({ name: file.name, mimeType: 'application/octet-stream', buffer: Buffer.from(file.bytes) });
}

function readProject(project: Buffer) {
  const entries = unzipSync(new Uint8Array(project));
  return {
    entries,
    fontPaths: Object.keys(entries).filter((name) => name.startsWith('fonts/')),
    manifest: JSON.parse(strFromU8(entries['manifest.json']!)) as { formatVersion: number; fonts: Record<string, unknown>[] },
    document: JSON.parse(strFromU8(entries['document.json']!)) as {
      schemaVersion: number;
      fonts: { family: string; source: string; embed: boolean; embeddable: boolean; files: unknown[]; faces: { localName?: string; files: number[] }[] }[];
    },
  };
}

test.beforeEach(async ({ page }) => {
  await useBasicFileAccess(page);
});

test('a Google font is downloaded once, travels inside the project, and then needs no network', async ({ page, browser }) => {
  const google = await mockGoogleFonts(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  const elsewhere: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith('http://localhost:4173') && !url.startsWith('data:') && !url.startsWith('blob:') && !GOOGLE.test(url)) elsewhere.push(url);
  });

  await startWithHeadline(page);
  const inAnton = await exportThroughDialog(page);
  const steps = await historyLength(page);

  // Browsing and searching the Google list contacts nobody: the list ships with the app.
  await openFontList(page);
  await page.getByTestId('font-filter-google').click();
  await page.getByTestId('font-search').fill('lobster');
  await expect(fontOption(page, 'Lobster', 'google')).toBeVisible();
  await expect(fontOption(page, 'Lobster Two', 'google')).toBeVisible();
  expect(google).toEqual({ stylesheets: [], files: [] });

  // Picking one downloads the family: one stylesheet, then each file once.
  await fontOption(page, 'Lobster', 'google').click();
  await expect(page.getByTestId('font-button')).toHaveAttribute('data-family', 'Lobster');
  expect(google.stylesheets).toEqual(['https://fonts.googleapis.com/css2?family=Lobster']);
  expect(google.files.slice().sort()).toEqual(['https://fonts.gstatic.com/s/lobster/v1/latin-ext.woff2', 'https://fonts.gstatic.com/s/lobster/v1/latin.woff2']);

  // It is now one of the design's fonts, and no longer something to download.
  await page.getByTestId('font-filter-all').click();
  await expect(fontOption(page, 'Lobster', 'design')).toHaveAttribute('aria-selected', 'true');
  await expect(fontOption(page, 'Lobster', 'google')).toHaveCount(0);
  await page.getByTestId('font-search').press('Escape');
  await expect(page.getByTestId('warnings')).toHaveCount(0);
  // Lobster has one weight and no italic, so neither control is offered.
  await expect(page.getByLabel('Weight')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Italic' })).toHaveCount(0);

  // Changing font is one undo step.
  expect(await historyLength(page)).toBe(steps + 1);
  const inLobster = await exportThroughDialog(page);
  expect(inLobster.equals(inAnton)).toBe(false);
  await page.getByTestId('undo-button').click();
  await expect(page.getByTestId('font-button')).toHaveAttribute('data-family', 'Anton');
  expect((await exportThroughDialog(page)).equals(inAnton)).toBe(true);
  await page.getByTestId('redo-button').click();
  await expect(page.getByTestId('font-button')).toHaveAttribute('data-family', 'Lobster');
  expect((await exportThroughDialog(page)).equals(inLobster)).toBe(true);

  // The project file carries the font files and says where they came from.
  const project = await saveProjectFile(page);
  const saved = readProject(project);
  expect(saved.manifest.formatVersion).toBe(2);
  expect(saved.manifest.fonts).toEqual([{ family: 'Lobster', weight: 400, style: 'normal', source: 'google', embedded: true, license: 'OFL-1.1' }]);
  expect(saved.document.schemaVersion).toBe(2);
  expect(saved.document.fonts).toHaveLength(1);
  expect(saved.document.fonts[0]).toMatchObject({ family: 'Lobster', source: 'google', embed: true });
  expect(saved.fontPaths).toHaveLength(2);
  expect(project.includes(Buffer.from(fontsourceFile('lobster', 'lobster-latin-400-normal.woff2')))).toBe(true);
  const requestsSoFar = google.stylesheets.length + google.files.length;

  // Another computer, with empty storage and no way to reach Google.
  const other = await freshComputer(browser);
  await openProjectFile(other.page, project);
  await expect(other.page.getByTestId('layer-row')).toHaveCount(1);
  await expect(other.page.getByTestId('warnings')).toHaveCount(0);
  expect((await exportThroughDialog(other.page)).equals(inLobster)).toBe(true);

  // Having arrived with the project, the font can be used in other designs there too.
  await other.page.getByRole('button', { name: 'Back to your designs' }).click();
  await other.page.getByTestId('new-thumbnail-720').click();
  await addHeadline(other.page);
  await pickFont(other.page, 'Lobster', 'library');
  await expect(other.page.getByTestId('warnings')).toHaveCount(0);
  expect(other.google).toEqual([]);
  await other.close();

  expect(google.stylesheets.length + google.files.length).toBe(requestsSoFar);
  expect(elsewhere).toEqual([]);
  expect(errors).toEqual([]);
});

test('when Google Fonts cannot be reached or a download is cancelled, nothing changes', async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort('internetdisconnected'));
  await startWithHeadline(page, 'Offline');
  const steps = await historyLength(page);

  await openFontList(page);
  await page.getByTestId('font-search').fill('Pacifico');
  await fontOption(page, 'Pacifico', 'google').click();
  await expect(page.getByTestId('toast')).toContainText('Google Fonts could not be reached');
  await expect(page.getByTestId('toast')).toContainText('Check your internet connection');
  await expect(page.getByTestId('toast')).toHaveAttribute('data-kind', 'error');
  await expect(page.getByTestId('font-button')).toHaveAttribute('data-family', 'Anton');
  await expect(page.getByTestId('font-progress')).toHaveCount(0);

  // Now Google answers, but slowly, and the person changes their mind.
  await page.unroute('https://fonts.googleapis.com/**');
  let release = () => undefined as void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const google = await mockGoogleFonts(page, { holdFiles: held });
  await fontOption(page, 'Pacifico', 'google').click();
  await expect(page.getByTestId('font-progress')).toContainText('0 of 2');
  await page.getByRole('button', { name: 'Cancel downloading Pacifico' }).click();
  await expect(page.getByTestId('font-progress')).toHaveCount(0);
  release();
  await expect(page.getByTestId('font-button')).toHaveAttribute('data-family', 'Anton');
  expect(google.stylesheets).toHaveLength(1);
  // A cancelled download is not left half-finished in the list of fonts on this machine.
  await page.getByTestId('font-filter-library').click();
  await page.getByTestId('font-search').fill('');
  await expect(fontOption(page, 'Pacifico', 'library')).toHaveCount(0);
  await page.getByTestId('font-search').press('Escape');

  expect(await historyLength(page)).toBe(steps);
  await expect(page.getByTestId('warnings')).toHaveCount(0);
});

test('an added font file stays on this computer unless the person includes it in the project', async ({ page, browser }) => {
  await startWithHeadline(page);
  const inAnton = await exportThroughDialog(page);

  await openFontList(page);
  await addFontFile(page, 'font-add-file', { name: 'Pacifico-Regular.woff', bytes: pacificoWoff() });
  // It is used straight away for the selected text.
  await expect(page.getByTestId('font-button')).toHaveAttribute('data-family', 'Pacifico');
  await expect(page.getByTestId('toast')).toContainText('Added Pacifico');
  await expect(fontOption(page, 'Pacifico', 'design')).toHaveAttribute('aria-selected', 'true');
  // Pacifico's own permission allows embedding, so the choice is offered. It starts off.
  const include = page.getByTestId('font-include');
  await expect(include).not.toBeChecked();
  await page.getByTestId('font-search').press('Escape');
  await expect(page.getByTestId('warnings')).toHaveCount(0);

  const inPacifico = await exportThroughDialog(page);
  expect(inPacifico.equals(inAnton)).toBe(false);

  // Saved without the font: the file names it, pins it, and does not contain it.
  const nameOnly = await saveProjectFile(page);
  const saved = readProject(nameOnly);
  expect(saved.fontPaths).toEqual([]);
  expect(saved.manifest.fonts).toEqual([{ family: 'Pacifico', weight: 400, style: 'normal', source: 'file', embedded: false }]);
  expect(saved.document.fonts[0]).toMatchObject({ family: 'Pacifico', source: 'file', embeddable: true, embed: false });
  expect(nameOnly.includes(Buffer.from(pacificoWoff()))).toBe(false);

  // Opened where the font is not available: reported, never swapped silently.
  const other = await freshComputer(browser);
  await openProjectFile(other.page, nameOnly);
  const warning = other.page.getByTestId('missing-font');
  await expect(warning).toContainText('The font file for Pacifico is not on this computer');
  await expect(warning).toContainText('stand-in font');
  await expect(other.page.getByTestId('layer-row').first()).toBeVisible();
  await other.page.getByTestId('layer-row').first().click();
  await expect(other.page.getByTestId('font-button')).toContainText('Pacifico (missing)');
  // Export stops and says why.
  await other.page.getByTestId('export-button').click();
  await other.page.getByTestId('export-confirm').click();
  const dialog = other.page.getByTestId('export-dialog');
  await expect(dialog.getByRole('alert')).toContainText('font that is not available: Pacifico');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // Adding the same font file there repairs it, with nothing else changing.
  const stepsBefore = await historyLength(other.page);
  await addFontFile(other.page, 'missing-font-add-file', { name: 'Pacifico-Regular.woff', bytes: pacificoWoff() });
  await expect(other.page.getByTestId('warnings')).toHaveCount(0);
  await expect(other.page.getByTestId('font-button')).not.toContainText('missing');
  expect(await historyLength(other.page)).toBe(stepsBefore);
  expect((await exportThroughDialog(other.page)).equals(inPacifico)).toBe(true);
  await other.close();

  // Back on the first computer: include the font, and the project opens anywhere.
  await openFontList(page);
  await include.check();
  await expect(include).toBeChecked();
  await page.getByTestId('font-search').press('Escape');
  const withFont = await saveProjectFile(page);
  const embedded = readProject(withFont);
  expect(embedded.fontPaths).toHaveLength(1);
  expect(embedded.fontPaths[0]).toMatch(/^fonts\/[0-9a-f]{64}\.woff$/);
  expect(Buffer.from(embedded.entries[embedded.fontPaths[0]!]!).equals(Buffer.from(pacificoWoff()))).toBe(true);
  expect(embedded.manifest.fonts).toEqual([{ family: 'Pacifico', weight: 400, style: 'normal', source: 'file', embedded: true }]);

  const third = await freshComputer(browser);
  await openProjectFile(third.page, withFont);
  await expect(third.page.getByTestId('warnings')).toHaveCount(0);
  expect((await exportThroughDialog(third.page)).equals(inPacifico)).toBe(true);
  expect(third.google).toEqual([]);
  await third.close();
});

test('a font that forbids embedding is never put inside a project, and unreadable files are refused', async ({ page }) => {
  await startWithHeadline(page, 'Restricted');
  await openFontList(page);

  // .woff2 cannot be inspected in a browser, so its permission cannot be checked.
  await addFontFile(page, 'font-add-file', { name: 'Pacifico.woff2', bytes: pacificoWoff2() });
  await expect(page.getByTestId('toast')).toContainText('Pacifico.woff2');
  await expect(page.getByTestId('toast')).toContainText('Use the .ttf or .otf version');
  await addFontFile(page, 'font-add-file', { name: 'holiday.ttf', bytes: new TextEncoder().encode('not a font, just some text in a file') });
  await expect(page.getByTestId('toast')).toContainText('holiday.ttf: This is not a font file');
  await expect(page.getByTestId('font-button')).toHaveAttribute('data-family', 'Anton');

  // The same font, but with its maker's permission set to "no embedding".
  await addFontFile(page, 'font-add-file', { name: 'Pacifico-Restricted.ttf', bytes: woffToSfnt(pacificoWoff(), { fsType: 0x0002 }) });
  await expect(page.getByTestId('font-button')).toHaveAttribute('data-family', 'Pacifico');
  await expect(page.getByTestId('font-include-row')).toContainText('Pacifico does not allow being put inside files');
  await expect(page.getByTestId('font-include')).toHaveCount(0);
  await page.getByTestId('font-search').press('Escape');
  await expect(page.getByTestId('warnings')).toHaveCount(0);

  const saved = readProject(await saveProjectFile(page));
  expect(saved.fontPaths).toEqual([]);
  expect(saved.document.fonts[0]).toMatchObject({ family: 'Pacifico', source: 'file', embeddable: false, embed: false });
});

test('the font menu works from the keyboard and offers only styles that exist', async ({ page }) => {
  await startWithHeadline(page, 'Keys');
  // Anton has a single weight and no italic.
  await expect(page.getByLabel('Weight')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Italic' })).toHaveCount(0);

  const button = page.getByTestId('font-button');
  await button.focus();
  await page.keyboard.press('Enter');
  const search = page.getByTestId('font-search');
  await expect(search).toBeFocused();
  // Typing narrows the list; Enter takes the first match.
  await page.keyboard.type('pop');
  await expect(fontOption(page, 'Poppins')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(button).toHaveAttribute('data-family', 'Poppins');
  // The menu stays open to try another; arrows move through the list.
  await search.fill('');
  await expect(fontOption(page, 'Poppins', 'design')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(button).toHaveAttribute('data-family', 'Montserrat');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('font-picker')).toBeHidden();
  await expect(button).toBeFocused();

  // Montserrat has three weights and italics: Anton's 400 carried over, and real choices appear.
  await expect(page.getByLabel('Weight')).toHaveValue('400');
  await expect(page.getByLabel('Weight').locator('option')).toHaveText(['Regular', 'Semibold', 'Extra bold']);
  await page.getByLabel('Weight').selectOption('800');
  await page.getByRole('button', { name: 'Italic' }).click();
  await expect(page.getByRole('button', { name: 'Italic' })).toHaveAttribute('aria-pressed', 'true');
  // Back to a family without italic or that weight: the text moves to what exists, never a fake style.
  await pickFont(page, 'Bebas Neue');
  await expect(page.getByLabel('Weight')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Italic' })).toHaveCount(0);
  await expect(page.getByTestId('warnings')).toHaveCount(0);

  // Every row in the open menu has a name, and nothing was asked of Google along the way.
  await openFontList(page);
  const unnamed = await page.getByTestId('font-picker').evaluate((panel) =>
    Array.from(panel.querySelectorAll<HTMLElement>('button, input, select, [role="option"]')).filter((el) => {
      const labelled = (el as HTMLInputElement).labels?.length ? Array.from((el as HTMLInputElement).labels!).some((l) => l.textContent?.trim()) : false;
      return !(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent?.trim()) && !labelled;
    }).length,
  );
  expect(unnamed).toBe(0);
});

test.describe('fonts installed on this computer', () => {
  test.use({ permissions: ['local-fonts'] });

  test('an installed font is used in place, reopens without asking, and is reported where it is missing', async ({ page, browser }) => {
    test.setTimeout(300_000);
    await startWithHeadline(page, 'Installed font 123');
    const inAnton = await exportThroughDialog(page);

    await openFontList(page);
    await page.getByTestId('font-filter-installed').click();
    const installed = page.locator('[data-testid="font-option"][data-group="installed"]');
    // The first listing in a fresh browser can take half a minute on a computer with many fonts.
    await expect(installed.first().or(page.getByTestId('font-list').getByText(/not allowed|Not possible/))).toBeVisible({ timeout: 150_000 });
    test.skip((await installed.count()) === 0, 'This machine lets the browser list no installed fonts.');

    // Prefer a font most systems have; otherwise take whatever is listed first.
    let family = (await installed.first().getAttribute('data-family'))!;
    for (const candidate of ['Courier New', 'Times New Roman', 'Georgia', 'DejaVu Serif', 'Liberation Serif']) {
      await page.getByTestId('font-search').fill(candidate);
      if ((await fontOption(page, candidate, 'installed').count()) > 0) {
        family = candidate;
        break;
      }
    }
    await page.getByTestId('font-search').fill(family);
    await fontOption(page, family, 'installed').first().click();
    await expect(page.getByTestId('font-button')).toHaveAttribute('data-family', family);
    await expect(page.getByTestId('toast')).toContainText(`${family} is on this computer`);
    await expect(page.getByTestId('font-include-row')).toContainText(family);
    await page.getByTestId('font-search').press('Escape');
    await expect(page.getByTestId('warnings')).toHaveCount(0);

    const inFamily = await exportThroughDialog(page);
    expect(inFamily.equals(inAnton)).toBe(false);

    // The project names the font and its exact faces. Nothing is copied.
    const project = await saveProjectFile(page);
    const saved = readProject(project);
    expect(saved.fontPaths).toEqual([]);
    expect(saved.document.fonts).toHaveLength(1);
    expect(saved.document.fonts[0]).toMatchObject({ family, source: 'installed', embed: false, files: [] });
    expect(saved.document.fonts[0]!.faces.length).toBeGreaterThan(0);
    expect(saved.document.fonts[0]!.faces.every((face) => !!face.localName && face.files.length === 0)).toBe(true);

    // Reopening on the same computer needs no permission and no network.
    const same = await freshComputer(browser);
    await openProjectFile(same.page, project);
    await expect(same.page.getByTestId('layer-row')).toHaveCount(1);
    await expect(same.page.getByTestId('warnings')).toHaveCount(0);
    expect((await exportThroughDialog(same.page)).equals(inFamily)).toBe(true);
    expect(same.google).toEqual([]);
    await same.close();

    // A computer without the font: pretend by renaming the faces to ones that do not exist.
    const document = saved.document;
    document.fonts[0]!.faces.forEach((face, index) => (face.localName = `NoSuchFont-${index}`));
    const elsewhere = Buffer.from(zipSync({ ...saved.entries, 'document.json': strToU8(JSON.stringify(document)) }));
    const other = await freshComputer(browser);
    await openProjectFile(other.page, elsewhere);
    await expect(other.page.getByTestId('missing-font')).toContainText(`The font ${family} is not installed on this computer`);
    await other.close();
  });
});
