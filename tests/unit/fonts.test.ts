import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/assets/assetStore';
import {
  addNode,
  createDocument,
  documentFont,
  firstPage,
  fontUseRecords,
  insertNodes,
  makeTextNode,
  nearestFace,
  pruneUnusedFonts,
  removeNodes,
  setTextFont,
} from '../../src/document/ops';
import { parseDocument } from '../../src/document/schema';
import { SCHEMA_VERSION, type DesignDocument, type DocumentFont } from '../../src/document/types';
import { addFontFiles, weightsOf } from '../../src/fonts/fontFiles';
import { embeddingPermission, FontParseError, mayEmbedInProject, parseFontInfo, sniffFontFormat } from '../../src/fonts/fontInfo';
import { documentFontFromLibrary, IdbFontStore, MemoryFontStore } from '../../src/fonts/fontStore';
import { decodeCatalogue, searchFamilies, type CatalogueFamily } from '../../src/fonts/googleCatalogue';
import { googleCssUrl, googlePreviewUrl, parseGoogleCss } from '../../src/fonts/googleCss';
import { downloadGoogleFamily, FontDownloadError } from '../../src/fonts/googleDownload';
import { embedInstalledFont, groupLocalFonts, installedDocumentFont, listLocalFamilies, unembedInstalledFont } from '../../src/fonts/localFonts';
import { guessStyle, stripWeightFromFamily } from '../../src/fonts/styleNames';
import { packProject, unpackProject } from '../../src/storage/projectFile';
import rawCatalogue from '../../src/fonts/google-catalogue.json';
import { fontsourceFile, lobsterWoff, lobsterWoff2, pacificoWoff, pacificoWoff2, woffToSfnt } from '../support/fontFixtures';

const here = path.dirname(fileURLToPath(import.meta.url));

function docWithText(): { doc: DesignDocument; id: string } {
  let doc = createDocument({ width: 1280, height: 720 });
  const node = makeTextNode(firstPage(doc), 'heading');
  doc = addNode(doc, node);
  return { doc, id: node.id };
}

const lobsterEntry: CatalogueFamily = { family: 'Lobster', category: 'Display', weights: [400], italics: [], license: 'OFL-1.1', large: false, rank: 0 };

describe('document format 2: fonts', () => {
  it('upgrades a format 1 document without changing anything else', () => {
    const v1 = JSON.parse(readFileSync(path.join(here, '..', 'fixtures', 'document-v1.json'), 'utf8'));
    const { doc, migratedFrom } = parseDocument(v1);
    expect(migratedFrom).toBe(1);
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
    // Format 1 could only use built-in fonts, so nothing needs listing.
    expect(doc.fonts).toEqual([]);
    const { schemaVersion: _old, ...before } = v1;
    const { schemaVersion: _new, fonts: _fonts, ...after } = doc;
    // Later formats add one field to photo layers (see upscale.test.ts); nothing else differs.
    const withoutLaterFields = { ...after, pages: after.pages.map((page) => ({ ...page, nodes: (page.nodes as unknown as Record<string, unknown>[]).map(({ upscale: _upscale, ...node }) => node) })) };
    expect(withoutLaterFields).toEqual(before);
    // The fixture itself is not touched, and upgrading twice gives the same result.
    expect(v1.schemaVersion).toBe(1);
    expect(parseDocument(doc).doc).toEqual(doc);
  });

  it('refuses a font table that contradicts itself', () => {
    const { doc } = docWithText();
    const font: DocumentFont = {
      family: 'Lobster',
      source: 'google',
      embeddable: true,
      embed: true,
      files: [{ id: 'a'.repeat(64), bytes: 10, format: 'woff2' }],
      faces: [{ weight: 400, style: 'normal', files: [0] }],
    };
    expect(parseDocument({ ...doc, fonts: [font] }).doc.fonts).toEqual([font]);
    expect(() => parseDocument({ ...doc, fonts: [font, font] })).toThrow(/listed twice/);
    expect(() => parseDocument({ ...doc, fonts: [{ ...font, embeddable: false }] })).toThrow(/may not be/);
    expect(() => parseDocument({ ...doc, fonts: [{ ...font, faces: [{ weight: 400, style: 'normal', files: [3] }] }] })).toThrow(/not listed/);
    expect(() => parseDocument({ ...doc, fonts: [{ ...font, files: [{ id: 'nope', bytes: 1, format: 'woff2' }] }] })).toThrow(/damaged/);
  });
});

describe('font operations', () => {
  const lobster: DocumentFont = {
    family: 'Lobster',
    source: 'google',
    license: 'OFL-1.1',
    embeddable: true,
    embed: true,
    files: [{ id: 'b'.repeat(64), bytes: 10, format: 'woff2' }],
    faces: [{ weight: 400, style: 'normal', files: [0] }],
  };

  it('picks the closest style a family really has', () => {
    const faces = [
      { weight: 300, style: 'normal' as const },
      { weight: 700, style: 'normal' as const },
      { weight: 400, style: 'italic' as const },
    ];
    expect(nearestFace(faces, 800, 'normal')).toEqual({ weight: 700, style: 'normal' });
    expect(nearestFace(faces, 400, 'normal')).toEqual({ weight: 300, style: 'normal' });
    expect(nearestFace(faces, 900, 'italic')).toEqual({ weight: 400, style: 'italic' });
    // No italic at all: fall back to upright rather than asking for a fake italic.
    expect(nearestFace([{ weight: 400, style: 'normal' }], 700, 'italic')).toEqual({ weight: 400, style: 'normal' });
    expect(nearestFace([], 400, 'normal')).toBeNull();
  });

  it('changes font in one step, records where it came from, and forgets fonts that are no longer used', () => {
    const { doc, id } = docWithText();
    // The heading preset is Montserrat 800.
    const withLobster = setTextFont(doc, [id], 'Lobster', [{ weight: 400, style: 'normal' }], lobster);
    expect(firstPage(withLobster).nodes[0]).toMatchObject({ fontFamily: 'Lobster', fontWeight: 400, fontStyle: 'normal' });
    expect(withLobster.fonts).toEqual([lobster]);
    expect(documentFont(withLobster, 'Lobster')).toBe(lobster);
    expect(doc.fonts).toEqual([]);
    expect(fontUseRecords(withLobster)).toEqual([
      { family: 'Lobster', weight: 400, style: 'normal', source: 'google', embedded: true, license: 'OFL-1.1' },
    ]);

    // Back to a built-in family: its record is not kept, and the unused one is dropped.
    const back = setTextFont(withLobster, [id], 'Inter', [{ weight: 400, style: 'normal' }, { weight: 800, style: 'normal' }], null);
    expect(back.fonts).toEqual([]);
    expect(fontUseRecords(back)).toEqual([{ family: 'Inter', weight: 400, style: 'normal', source: 'bundled', embedded: false }]);

    expect(pruneUnusedFonts(removeNodes(withLobster, [id])).fonts).toEqual([]);
    expect(pruneUnusedFonts(withLobster)).toBe(withLobster);
  });

  it('brings a font along when text is pasted into another design, without replacing a pinned one', () => {
    const { doc, id } = docWithText();
    const source = setTextFont(doc, [id], 'Lobster', [{ weight: 400, style: 'normal' }], lobster);
    const node = { ...firstPage(source).nodes[0]!, id: 'text_pasted' };

    const empty = createDocument({ width: 100, height: 100 });
    expect(insertNodes(empty, [node], [], [lobster]).fonts).toEqual([lobster]);

    const pinned: DocumentFont = { ...lobster, files: [{ id: 'c'.repeat(64), bytes: 12, format: 'woff2' }] };
    const target = { ...empty, fonts: [pinned] };
    expect(insertNodes(target, [node], [], [lobster]).fonts).toEqual([pinned]);
  });
});

describe('reading font files', () => {
  it('reads names, weight, style and embedding permission from a WOFF file', () => {
    const info = parseFontInfo(pacificoWoff());
    expect(info).toMatchObject({ format: 'woff', collection: false, family: 'Pacifico', weight: 400, italic: false, weightRange: null });
    expect(info.postscriptName).toMatch(/Pacifico/);
    expect(info.fsType).toBe(0);
    expect(info.embedding).toBe('installable');

    expect(parseFontInfo(fontsourceFile('inter', 'inter-latin-800-italic.woff'))).toMatchObject({ family: 'Inter', weight: 800, italic: true });
    expect(parseFontInfo(fontsourceFile('montserrat', 'montserrat-latin-600-normal.woff'))).toMatchObject({ family: 'Montserrat', weight: 600, italic: false });
  });

  it('reads a plain TrueType file the same way', () => {
    const ttf = woffToSfnt(pacificoWoff());
    expect(sniffFontFormat(ttf)).toBe('ttf');
    expect(parseFontInfo(ttf)).toMatchObject({ format: 'ttf', family: 'Pacifico', weight: 400, italic: false, embedding: 'installable' });
  });

  it('understands the embedding permission a font maker set', () => {
    expect(embeddingPermission(0x0000)).toBe('installable');
    expect(embeddingPermission(0x0002)).toBe('restricted');
    expect(embeddingPermission(0x0004)).toBe('preview-print');
    expect(embeddingPermission(0x0008)).toBe('editable');
    // No subsetting does not stop whole-file embedding.
    expect(embeddingPermission(0x0100)).toBe('installable');
    expect(embeddingPermission(0x0108)).toBe('editable');
    expect(embeddingPermission(0x0200)).toBe('bitmap-only');
    // Several levels set: the least restrictive applies.
    expect(embeddingPermission(0x000c)).toBe('editable');
    expect(embeddingPermission(0x0006)).toBe('preview-print');
    expect(embeddingPermission(null)).toBe('unknown');

    // A project file is edited and carries the whole font, so view-only permission is not enough.
    expect(['installable', 'editable'].map((p) => mayEmbedInProject(p as 'installable'))).toEqual([true, true]);
    expect(['preview-print', 'restricted', 'bitmap-only', 'unknown'].map((p) => mayEmbedInProject(p as 'unknown'))).toEqual([false, false, false, false]);

    expect(parseFontInfo(woffToSfnt(pacificoWoff(), { fsType: 0x0002 })).embedding).toBe('restricted');
    expect(parseFontInfo(woffToSfnt(pacificoWoff(), { fsType: 0x0004 })).embedding).toBe('preview-print');
    expect(parseFontInfo(woffToSfnt(pacificoWoff(), { fsType: 0x0008 })).embedding).toBe('editable');
  });

  it('says plainly when a file cannot be read', () => {
    expect(sniffFontFormat(pacificoWoff2())).toBe('woff2');
    expect(() => parseFontInfo(pacificoWoff2())).toThrow(FontParseError);
    expect(() => parseFontInfo(pacificoWoff2())).toThrow(/\.ttf or \.otf/);
    expect(() => parseFontInfo(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]))).toThrow(/not a font/);
    expect(() => parseFontInfo(pacificoWoff().subarray(0, 60))).toThrow(FontParseError);
  });

  it('offers every weight of a variable font, and one for an ordinary font', () => {
    expect(weightsOf({ weight: 400, weightRange: null })).toEqual([400]);
    expect(weightsOf({ weight: 400, weightRange: [300, 700] })).toEqual([300, 400, 500, 600, 700]);
    expect(weightsOf({ weight: 400, weightRange: [100, 1000] })).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900]);
    expect(weightsOf({ weight: 450, weightRange: [420, 480] })).toEqual([450]);
  });
});

describe('adding font files', () => {
  it('keeps the file on this machine and records what the font allows', async () => {
    const store = new MemoryFontStore();
    const now = new Date('2026-11-20T12:00:00Z');
    const result = await addFontFiles([{ name: 'Pacifico.woff', bytes: pacificoWoff() }], store, { now });
    expect(result.problems).toEqual([]);
    const id = await sha256Hex(pacificoWoff());
    expect(result.fonts).toEqual([
      {
        family: 'Pacifico',
        source: 'file',
        embeddable: true,
        files: [{ id, bytes: pacificoWoff().length, format: 'woff' }],
        faces: [{ weight: 400, style: 'normal', files: [0] }],
        addedAt: now.toISOString(),
      },
    ]);
    expect(await store.hasFile(id)).toBe(true);
    expect(await store.getFamily('Pacifico')).toEqual(result.fonts[0]);
    // In a design it is not put inside project files unless the person says so.
    expect(documentFontFromLibrary(result.fonts[0]!)).toMatchObject({ source: 'file', embeddable: true, embed: false });
  });

  it('adds further styles to a family and never marks a restricted font as embeddable', async () => {
    const store = new MemoryFontStore();
    const regular = fontsourceFile('inter', 'inter-latin-400-normal.woff');
    const boldItalic = woffToSfnt(fontsourceFile('inter', 'inter-latin-800-italic.woff'), { fsType: 0x0002 });
    await addFontFiles([{ name: 'a.woff', bytes: regular }], store);
    expect((await store.getFamily('Inter'))!.embeddable).toBe(true);
    const second = await addFontFiles([{ name: 'b.ttf', bytes: boldItalic }], store);
    expect(second.fonts[0]!.faces).toEqual([
      { weight: 400, style: 'normal', files: [0] },
      { weight: 800, style: 'italic', files: [1] },
    ]);
    expect(second.fonts[0]!.files.map((file) => file.format)).toEqual(['woff', 'ttf']);
    // One restricted file is enough: the family as a whole is not put inside project files.
    expect(second.fonts[0]!.embeddable).toBe(false);
    // Adding the same file again changes nothing.
    const again = await addFontFiles([{ name: 'a.woff', bytes: regular }], store);
    expect(again.fonts[0]!.files).toHaveLength(2);
    expect(again.fonts[0]!.faces).toHaveLength(2);
  });

  it('explains what it refuses', async () => {
    const store = new MemoryFontStore();
    const result = await addFontFiles(
      [
        { name: 'Pacifico.woff2', bytes: pacificoWoff2() },
        { name: 'notes.txt', bytes: new TextEncoder().encode('this is not a font at all') },
        { name: 'Anton.woff', bytes: fontsourceFile('anton', 'anton-latin-400-normal.woff') },
      ],
      store,
      { isBuiltIn: (family) => family === 'Anton' },
    );
    expect(result.fonts).toEqual([]);
    expect(result.problems).toHaveLength(3);
    expect(result.problems[0]).toMatch(/Pacifico\.woff2: .*\.ttf or \.otf/);
    expect(result.problems[1]).toMatch(/notes\.txt: This is not a font file/);
    expect(result.problems[2]).toMatch(/Anton is already built into the editor/);
    expect(await store.listFamilies()).toEqual([]);
  });
});

describe('Google Fonts', () => {
  const css = `/* latin-ext */
@font-face {
  font-family: 'Lobster';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/lobster/v32/ext.woff2) format('woff2');
  unicode-range: U+0100-02BA, U+02BD-02C5;
}
/* latin */
@font-face {
  font-family: 'Lobster';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/lobster/v32/latin.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131;
}
@font-face {
  font-family: 'Lobster';
  font-style: italic;
  font-weight: 700;
  src: url(https://fonts.gstatic.com/s/lobster/v32/latin.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131;
}
@font-face {
  font-family: 'Lobster';
  font-style: normal;
  font-weight: 400;
  src: url(https://evil.example/steal.woff2) format('woff2');
}`;

  it('builds the address for exactly the styles a family has', () => {
    expect(googleCssUrl('Lobster', [400], [])).toBe('https://fonts.googleapis.com/css2?family=Lobster');
    expect(googleCssUrl('Bebas Neue', [400], [])).toBe('https://fonts.googleapis.com/css2?family=Bebas+Neue');
    expect(googleCssUrl('Oswald', [700, 200, 400], [])).toBe('https://fonts.googleapis.com/css2?family=Oswald:wght@200;400;700');
    expect(googleCssUrl('Buda', [300], [])).toBe('https://fonts.googleapis.com/css2?family=Buda:wght@300');
    expect(googleCssUrl('Open Sans', [400, 700], [700, 400])).toBe(
      'https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,400;0,700;1,400;1,700',
    );
    expect(googlePreviewUrl('Lobster Two', 'Lobster Two')).toBe('https://fonts.googleapis.com/css2?family=Lobster+Two&text=Lobster%20Two');
  });

  it('reads the font files out of the stylesheet and ignores any other host', () => {
    const rules = parseGoogleCss(css);
    expect(rules).toEqual([
      { family: 'Lobster', weight: 400, style: 'normal', url: 'https://fonts.gstatic.com/s/lobster/v32/ext.woff2', format: 'woff2', unicodeRange: 'U+0100-02BA, U+02BD-02C5' },
      { family: 'Lobster', weight: 400, style: 'normal', url: 'https://fonts.gstatic.com/s/lobster/v32/latin.woff2', format: 'woff2', unicodeRange: 'U+0000-00FF, U+0131' },
      { family: 'Lobster', weight: 700, style: 'italic', url: 'https://fonts.gstatic.com/s/lobster/v32/latin.woff2', format: 'woff2', unicodeRange: 'U+0000-00FF, U+0131' },
    ]);
    expect(parseGoogleCss('<!DOCTYPE html><html>error</html>')).toEqual([]);
    expect(parseGoogleCss("@font-face { font-family: 'X'; src: url(https://fonts.gstatic.com/s/x/v1/x.ttf) format('truetype'); }")).toEqual([
      { family: 'X', weight: 400, style: 'normal', url: 'https://fonts.gstatic.com/s/x/v1/x.ttf', format: 'ttf' },
    ]);
  });

  function fakeFetch(log: string[], overrides: Record<string, () => Response | Promise<Response>> = {}): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const url = String(input);
      log.push(url);
      if (overrides[url]) return overrides[url]!();
      if (url.startsWith('https://fonts.googleapis.com/')) return new Response(css, { status: 200 });
      if (url.endsWith('/latin.woff2')) return new Response(lobsterWoff2() as BodyInit, { status: 200 });
      if (url.endsWith('/ext.woff2')) return new Response(pacificoWoff2() as BodyInit, { status: 200 });
      return new Response('nope', { status: 404 });
    }) as typeof fetch;
  }

  it('downloads a whole family once, stores each file under its hash and reports progress', async () => {
    const store = new MemoryFontStore();
    const log: string[] = [];
    const progress: string[] = [];
    const font = await downloadGoogleFamily(lobsterEntry, store, {
      fetch: fakeFetch(log),
      onProgress: (done, total) => progress.push(`${done}/${total}`),
      now: new Date('2026-11-20T12:00:00Z'),
    });
    // The stylesheet, then each distinct file once. Nothing from the other host.
    expect(log[0]).toBe('https://fonts.googleapis.com/css2?family=Lobster');
    expect(log.slice(1).sort()).toEqual(['https://fonts.gstatic.com/s/lobster/v32/ext.woff2', 'https://fonts.gstatic.com/s/lobster/v32/latin.woff2']);
    expect(progress[0]).toBe('0/2');
    expect(progress.at(-1)).toBe('2/2');

    const latinId = await sha256Hex(lobsterWoff2());
    const extId = await sha256Hex(pacificoWoff2());
    expect(font).toMatchObject({ family: 'Lobster', source: 'google', license: 'OFL-1.1', embeddable: true, addedAt: '2026-11-20T12:00:00.000Z' });
    expect(font.files).toEqual([
      { id: extId, bytes: pacificoWoff2().length, format: 'woff2', unicodeRange: 'U+0100-02BA, U+02BD-02C5' },
      { id: latinId, bytes: lobsterWoff2().length, format: 'woff2', unicodeRange: 'U+0000-00FF, U+0131' },
    ]);
    expect(font.faces).toEqual([
      { weight: 400, style: 'normal', files: [0, 1] },
      { weight: 700, style: 'italic', files: [1] },
    ]);
    expect(Array.from((await store.getFile(latinId))!.bytes.subarray(0, 4))).toEqual([0x77, 0x4f, 0x46, 0x32]);
    expect(await store.getFamily('Lobster')).toEqual(font);
    // Openly licensed: it always travels with the project.
    expect(documentFontFromLibrary(font)).toMatchObject({ source: 'google', license: 'OFL-1.1', embeddable: true, embed: true });
  });

  it('fails with a plain reason and stores no family when something goes wrong', async () => {
    const attempt = async (fetchImpl: typeof fetch, signal?: AbortSignal) => {
      const store = new MemoryFontStore();
      const error = await downloadGoogleFamily(lobsterEntry, store, { fetch: fetchImpl, ...(signal ? { signal } : {}) }).catch((e: unknown) => e);
      expect(await store.listFamilies()).toEqual([]);
      expect(error).toBeInstanceOf(FontDownloadError);
      return error as FontDownloadError;
    };
    const offline = await attempt((async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch);
    expect(offline.code).toBe('offline');
    expect(offline.message).toMatch(/Check your internet connection/);

    const cssUrl = 'https://fonts.googleapis.com/css2?family=Lobster';
    expect((await attempt(fakeFetch([], { [cssUrl]: () => new Response('<html>', { status: 400 }) }))).code).toBe('not-found');
    expect((await attempt(fakeFetch([], { [cssUrl]: () => new Response('oops', { status: 503 }) }))).code).toBe('bad-response');
    expect((await attempt(fakeFetch([], { [cssUrl]: () => new Response('body { color: red }', { status: 200 }) }))).code).toBe('bad-response');
    const notAFont = { 'https://fonts.gstatic.com/s/lobster/v32/latin.woff2': () => new Response('<html>not a font</html>', { status: 200 }) };
    expect((await attempt(fakeFetch([], notAFont))).code).toBe('bad-response');

    const controller = new AbortController();
    controller.abort();
    expect((await attempt(fakeFetch([]), controller.signal)).code).toBe('cancelled');
  });

  it('ships a catalogue of openly licensed families, without any font files', () => {
    const families = decodeCatalogue(rawCatalogue as unknown as Parameters<typeof decodeCatalogue>[0]);
    expect(families.length).toBeGreaterThan(1500);
    const allowed = new Set(['OFL-1.1', 'Apache-2.0', 'UFL-1.0']);
    for (const entry of families) {
      expect(entry.family).toBeTruthy();
      expect(entry.weights.length).toBeGreaterThan(0);
      expect(allowed.has(entry.license)).toBe(true);
    }
    expect(new Set(families.map((f) => f.family)).size).toBe(families.length);
    expect(families.find((f) => f.family === 'Lobster')).toMatchObject({ category: 'Display', weights: [400], italics: [], license: 'OFL-1.1', large: false });
    expect(families.find((f) => f.family === 'Roboto')!.weights).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900]);
    expect(families.find((f) => f.family === 'Noto Sans JP')!.large).toBe(true);

    // Search: names that start with the text come first, then names that contain it.
    const found = searchFamilies(families, ' lob ').map((f) => f.family);
    expect(found.slice(0, 2).sort()).toEqual(['Lobster', 'Lobster Two']);
    expect(searchFamilies(families, 'zzzz-no-such-font')).toEqual([]);
    expect(searchFamilies(families, '')).toHaveLength(families.length);
  });
});

describe('fonts installed on the computer', () => {
  it('works out weight and italic from the style names systems use', () => {
    expect(guessStyle('Regular')).toEqual({ weight: 400, italic: false, rest: '' });
    expect(guessStyle('Bold Italic')).toEqual({ weight: 700, italic: true, rest: '' });
    expect(guessStyle('SemiBold')).toEqual({ weight: 600, italic: false, rest: '' });
    expect(guessStyle('Demi Bold Italic')).toEqual({ weight: 600, italic: true, rest: '' });
    expect(guessStyle('UltraLight')).toEqual({ weight: 200, italic: false, rest: '' });
    expect(guessStyle('Ultra Light Italic')).toEqual({ weight: 200, italic: true, rest: '' });
    expect(guessStyle('ExtraBold')).toEqual({ weight: 800, italic: false, rest: '' });
    expect(guessStyle('Extrabold Italic')).toEqual({ weight: 800, italic: true, rest: '' });
    expect(guessStyle('Black Oblique')).toEqual({ weight: 900, italic: true, rest: '' });
    expect(guessStyle('BoldOblique')).toEqual({ weight: 700, italic: true, rest: '' });
    expect(guessStyle('Book')).toEqual({ weight: 400, italic: false, rest: '' });
    expect(guessStyle('Heavy')).toEqual({ weight: 800, italic: false, rest: '' });
    expect(guessStyle('W6')).toEqual({ weight: 600, italic: false, rest: '' });
    expect(guessStyle('B')).toEqual({ weight: 700, italic: false, rest: '' });
    // A weight written into the family name is only removed when it matches the font's real weight.
    expect(stripWeightFromFamily('Inter ExtraBold', 800)).toBe('Inter');
    expect(stripWeightFromFamily('Source Sans Semi Bold', 600)).toBe('Source Sans');
    expect(stripWeightFromFamily('Bold', 700)).toBe('Bold');
    expect(stripWeightFromFamily('Black Ops One', 400)).toBe('Black Ops One');
    expect(stripWeightFromFamily('Roboto Black', 400)).toBe('Roboto Black');
    // A narrow or wide design is a different family, not a weight.
    expect(guessStyle('Condensed Bold')).toEqual({ weight: 700, italic: false, rest: 'Condensed' });
    expect(guessStyle('Condensed ExtraBold')).toEqual({ weight: 800, italic: false, rest: 'Condensed' });
    expect(guessStyle('Outline 6 Dot')).toEqual({ weight: 400, italic: false, rest: 'Outline 6 Dot' });
  });

  it('groups faces into families, giving narrow variants their own entry', () => {
    const face = (family: string, style: string, postscriptName: string) => ({ family, style, postscriptName, fullName: `${family} ${style}` });
    const groups = groupLocalFonts([
      face('Futura', 'Medium', 'Futura-Medium'),
      face('Futura', 'Bold', 'Futura-Bold'),
      face('Futura', 'Condensed ExtraBold', 'Futura-CondensedExtraBold'),
      face('Futura', 'Medium Italic', 'Futura-MediumItalic'),
      face('Arial', 'Regular', 'ArialMT'),
      face('Arial', 'Regular', 'ArialMT-Duplicate'),
      face('.SF Hidden', 'Regular', '.SFHidden'),
    ]);
    expect(groups.map((g) => g.family)).toEqual(['Arial', 'Futura', 'Futura Condensed']);
    expect(groups[0]!.faces).toHaveLength(1);
    expect(groups[1]!.faces.map((f) => [f.postscriptName, f.weight, f.italic])).toEqual([
      ['Futura-Medium', 500, false],
      ['Futura-Bold', 700, false],
      ['Futura-MediumItalic', 500, true],
    ]);
    expect(groups[2]!.faces.map((f) => [f.postscriptName, f.weight])).toEqual([['Futura-CondensedExtraBold', 800]]);
  });
});

describe('installed fonts: what a design keeps', () => {
  type Installed = { postscriptName: string; style: string; bytes: Uint8Array };
  const scope = globalThis as { queryLocalFonts?: unknown };

  /** Stand in for the browser's list of installed fonts. */
  function install(faces: Installed[]): void {
    scope.queryLocalFonts = async (options?: { postscriptNames?: string[] }) =>
      faces
        .filter((face) => !options?.postscriptNames || options.postscriptNames.includes(face.postscriptName))
        .map((face) => ({
          family: 'Pacifico',
          fullName: `Pacifico ${face.style}`,
          postscriptName: face.postscriptName,
          style: face.style,
          blob: async () => new Blob([face.bytes as BlobPart]),
        }));
  }
  afterEach(() => {
    delete scope.queryLocalFonts;
  });

  it('keeps names only, and copies the files only when the font allows it and the person asks', async () => {
    const bytes = woffToSfnt(pacificoWoff());
    // The system calls this face "Bold"; the font's own data says regular, and that wins.
    install([{ postscriptName: 'Pacifico-Regular', style: 'Bold', bytes }]);
    const [family] = await listLocalFamilies();
    expect(family).toMatchObject({ family: 'Pacifico', faces: [{ postscriptName: 'Pacifico-Regular', weight: 700 }] });

    const font = await installedDocumentFont(family!);
    expect(font).toEqual({
      family: 'Pacifico',
      source: 'installed',
      embeddable: true,
      embed: false,
      files: [],
      faces: [{ weight: 400, style: 'normal', files: [], localName: 'Pacifico-Regular' }],
    });

    const store = new MemoryFontStore();
    const included = await embedInstalledFont(font, store);
    const id = await sha256Hex(bytes);
    expect(included).toEqual({
      ...font,
      embed: true,
      files: [{ id, bytes: bytes.length, format: 'ttf' }],
      faces: [{ weight: 400, style: 'normal', files: [0], localName: 'Pacifico-Regular' }],
    });
    expect(await store.hasFile(id)).toBe(true);
    // Changing their mind takes the design back to names only.
    expect(unembedInstalledFont(included!)).toEqual(font);
  });

  it('never copies a font that forbids embedding, or one it cannot read', async () => {
    install([{ postscriptName: 'Pacifico-Regular', style: 'Regular', bytes: woffToSfnt(pacificoWoff(), { fsType: 0x0002 }) }]);
    const restricted = await installedDocumentFont((await listLocalFamilies())[0]!);
    expect(restricted).toMatchObject({ embeddable: false, embed: false, files: [] });
    const store = new MemoryFontStore();
    expect(await embedInstalledFont(restricted, store)).toBeNull();
    // Even if a design claimed otherwise, the font's own data is checked again before copying.
    expect(await embedInstalledFont({ ...restricted, embeddable: true }, store)).toBeNull();

    install([{ postscriptName: 'Mystery-Regular', style: 'Light Italic', bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const unreadable = await installedDocumentFont((await listLocalFamilies())[0]!);
    // Still usable by name, with the style taken from what the system reports.
    expect(unreadable).toMatchObject({ embeddable: false, faces: [{ weight: 300, style: 'italic', files: [], localName: 'Mystery-Regular' }] });
    expect(await embedInstalledFont({ ...unreadable, embeddable: true }, store)).toBeNull();
    expect(await store.listFamilies()).toEqual([]);
  });
});

describe('fonts in project files', () => {
  async function designWith(font: (library: Awaited<ReturnType<typeof addFontFiles>>['fonts'][number]) => DocumentFont) {
    const store = new MemoryFontStore();
    const [library] = (await addFontFiles([{ name: 'Pacifico.woff', bytes: pacificoWoff() }], store)).fonts;
    const { doc, id } = docWithText();
    const record = font(library!);
    return { store, id, record, doc: setTextFont(doc, [id], 'Pacifico', record.faces, record) };
  }
  const pack = (doc: DesignDocument, store: MemoryFontStore) =>
    packProject({ doc, getAsset: async () => undefined, getFontFile: (id) => store.getFile(id), appVersion: '0.1.0' });

  it('carries a font inside the file only when the design says it may', async () => {
    const included = await designWith((library) => ({ ...documentFontFromLibrary(library), embed: true }));
    const packed = await pack(included.doc, included.store);
    expect(packed.missingFonts).toEqual([]);
    const opened = await unpackProject(packed.bytes);
    expect(opened.doc).toEqual(included.doc);
    expect(opened.fontFiles).toHaveLength(1);
    expect(opened.fontFiles[0]!.id).toBe(included.record.files[0]!.id);
    expect(Array.from(opened.fontFiles[0]!.bytes)).toEqual(Array.from(pacificoWoff()));
    expect(opened.manifest.fonts).toEqual([{ family: 'Pacifico', weight: 400, style: 'normal', source: 'file', embedded: true }]);

    const nameOnly = await designWith((library) => documentFontFromLibrary(library));
    expect(nameOnly.record.embed).toBe(false);
    const reopened = await unpackProject((await pack(nameOnly.doc, nameOnly.store)).bytes);
    // The design still names the font and pins its file, but the file does not travel.
    expect(reopened.doc.fonts).toEqual([nameOnly.record]);
    expect(reopened.fontFiles).toEqual([]);
    expect(reopened.manifest.fonts).toEqual([{ family: 'Pacifico', weight: 400, style: 'normal', source: 'file', embedded: false }]);
  });

  it('reports a font it could not include, and ignores font files that were altered or are not wanted', async () => {
    const { doc, record } = await designWith((library) => ({ ...documentFontFromLibrary(library), embed: true }));
    const empty = new MemoryFontStore();
    const packed = await pack(doc, empty);
    expect(packed.missingFonts).toEqual(['Pacifico']);
    expect((await unpackProject(packed.bytes)).fontFiles).toEqual([]);

    // Build a file whose font bytes do not match their name, plus an extra font nobody asked for.
    const { zipSync, strToU8 } = await import('fflate');
    const tampered = zipSync({
      'manifest.json': strToU8(JSON.stringify({ format: 'fvs-design-project', formatVersion: 2 })),
      'document.json': strToU8(JSON.stringify(doc)),
      [`fonts/${record.files[0]!.id}.woff`]: lobsterWoff(),
      [`fonts/${'d'.repeat(64)}.woff`]: pacificoWoff(),
    });
    const opened = await unpackProject(tampered);
    expect(opened.fontFiles).toEqual([]);
    expect(opened.doc.fonts).toEqual([record]);
  });

  it('does not keep fonts that no text uses', async () => {
    const { doc, id, store } = await designWith((library) => ({ ...documentFontFromLibrary(library), embed: true }));
    const opened = await unpackProject((await pack(removeNodes(doc, [id]), store)).bytes);
    expect(opened.doc.fonts).toEqual([]);
    expect(opened.fontFiles).toEqual([]);
  });
});

describe('font storage in the browser', () => {
  it('keeps font files under their hash and remembers families', async () => {
    const store = new IdbFontStore();
    const bytes = lobsterWoff();
    const id = await sha256Hex(bytes);
    expect(await store.hasFile(id)).toBe(false);
    await store.putFile({ id, bytes });
    expect(await store.hasFile(id)).toBe(true);
    expect(Array.from((await store.getFile(id))!.bytes)).toEqual(Array.from(bytes));
    expect(await store.getFile('e'.repeat(64))).toBeUndefined();

    const family = {
      family: 'Lobster',
      source: 'google' as const,
      license: 'OFL-1.1',
      embeddable: true,
      files: [{ id, bytes: bytes.length, format: 'woff' as const }],
      faces: [{ weight: 400, style: 'normal' as const, files: [0] }],
      addedAt: '2026-11-20T12:00:00.000Z',
    };
    await store.putFamily(family);
    expect(await store.getFamily('Lobster')).toEqual(family);
    expect((await store.listFamilies()).map((f) => f.family)).toEqual(['Lobster']);
    await store.deleteFamily('Lobster');
    expect(await store.getFamily('Lobster')).toBeUndefined();
    // Removing a family from the list leaves its files, which designs may still pin.
    expect(await store.hasFile(id)).toBe(true);
  });
});
