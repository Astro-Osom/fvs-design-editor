import { documentFont, findNode, setDocumentFont, setTextFont, type FaceKey } from '../document/ops';
import type { DocumentFont, NodeId } from '../document/types';
import { addFontFiles, FONT_FILE_ACCEPT } from '../fonts/fontFiles';
import { documentFontFromLibrary, type LibraryFont } from '../fonts/fontStore';
import { findGoogleFamily, type CatalogueFamily } from '../fonts/googleCatalogue';
import { downloadGoogleFamily, FontDownloadError } from '../fonts/googleDownload';
import { embedInstalledFont, installedDocumentFont, unembedInstalledFont, type LocalFamily } from '../fonts/localFonts';
import { pickFiles } from '../platform/files';
import { availableFaces, findBundledFont, forgetFontFamily, isBundledFamily } from '../render/fonts';
import { isQuotaError } from '../storage/idb';
import { editorRef, fonts } from './services';
import { commitDoc, currentDoc, selectDoc, showToast, store } from './store';

/** What the interface can ask for when it comes to fonts. */

export type FontChoice =
  /** One of the editor's built-in fonts. */
  | { kind: 'builtin'; family: string }
  /** A font this design already uses. */
  | { kind: 'design'; family: string }
  /** A font already on this machine: downloaded from Google Fonts, or added from a file. */
  | { kind: 'library'; font: LibraryFont }
  /** A Google font that has not been downloaded yet. */
  | { kind: 'google'; entry: CatalogueFamily }
  /** A font installed on this computer. */
  | { kind: 'installed'; family: LocalFamily };

export interface ChooseFontOptions {
  signal?: AbortSignal;
  onProgress?(done: number, total: number): void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function textIds(ids: readonly NodeId[]): NodeId[] {
  const doc = selectDoc(store.getState());
  if (!doc) return [];
  return ids.filter((id) => findNode(doc, id)?.node.type === 'text');
}

function applyFamily(ids: readonly NodeId[], family: string, font: DocumentFont | null): boolean {
  const targets = textIds(ids);
  if (!targets.length) return false;
  const faces: FaceKey[] = font ? font.faces.map((face) => ({ weight: face.weight, style: face.style })) : availableFaces(currentDoc(), family);
  return commitDoc(setTextFont(currentDoc(), targets, family, faces, font), 'Change font');
}

/** A design that already uses this family from the same source keeps its own pinned copy. */
function keepPinned(family: string, source: DocumentFont['source'], fresh: () => DocumentFont): DocumentFont {
  const existing = documentFont(currentDoc(), family);
  return existing && existing.source === source ? existing : fresh();
}

/**
 * Use a font for the selected text. Downloads it first if needed. Returns false
 * if nothing changed (including when a download was cancelled or failed; the
 * reason is shown to the person).
 */
export async function chooseFont(choice: FontChoice, options: ChooseFontOptions = {}): Promise<boolean> {
  // The selection is remembered now, because a download can take a few seconds.
  const ids = store.getState().selection.slice();
  if (!textIds(ids).length) return false;
  editorRef.current?.finishTextEditing();
  try {
    switch (choice.kind) {
      case 'builtin':
        if (!findBundledFont(choice.family)) return false;
        return applyFamily(ids, choice.family, null);
      case 'design': {
        if (isBundledFamily(choice.family)) return applyFamily(ids, choice.family, null);
        const font = documentFont(currentDoc(), choice.family);
        return font ? applyFamily(ids, choice.family, font) : false;
      }
      case 'library': {
        const { font } = choice;
        if (isBundledFamily(font.family)) return applyFamily(ids, font.family, null);
        return applyFamily(ids, font.family, keepPinned(font.family, font.source, () => documentFontFromLibrary(font)));
      }
      case 'google': {
        const { entry } = choice;
        if (isBundledFamily(entry.family)) return applyFamily(ids, entry.family, null);
        const library = (await fonts.getFamily(entry.family)) ?? (await downloadGoogleFamily(entry, fonts, options));
        if (library.source !== 'google') {
          showToast('error', `${entry.family} is already here as a font file you added. Pick it from "Added and downloaded".`);
          return false;
        }
        return applyFamily(ids, entry.family, keepPinned(entry.family, 'google', () => documentFontFromLibrary(library)));
      }
      case 'installed': {
        const { family } = choice;
        if (isBundledFamily(family.family)) return applyFamily(ids, family.family, null);
        const existing = documentFont(currentDoc(), family.family);
        const font = existing?.source === 'installed' ? existing : await installedDocumentFont(family);
        if (!font.faces.length) {
          showToast('error', `${family.family} could not be read from this computer.`);
          return false;
        }
        const changed = applyFamily(ids, family.family, font);
        if (changed && existing?.source !== 'installed') {
          showToast('info', `${family.family} is on this computer. On another computer the design needs the same font installed.`);
        }
        return changed;
      }
    }
  } catch (error) {
    if (error instanceof FontDownloadError && error.code === 'cancelled') return false;
    showToast('error', isQuotaError(error) ? 'There is not enough storage space to keep that font.' : messageOf(error));
    return false;
  }
}

/** Let the person pick font files, add them to this machine's fonts, and report anything that was refused. */
export async function addFontFilesFromPicker(): Promise<LibraryFont[]> {
  try {
    const picked = await pickFiles(FONT_FILE_ACCEPT, true);
    if (!picked.length) return [];
    const inputs = await Promise.all(
      picked.map(async (file) => ({ name: file instanceof File && file.name ? file.name : 'Font file', bytes: new Uint8Array(await file.arrayBuffer()) })),
    );
    const result = await addFontFiles(inputs, fonts, { isBuiltIn: isBundledFamily });
    if (result.problems.length) showToast('error', result.problems.join(' '));
    else if (result.fonts.length) {
      const names = result.fonts.map((font) => font.family).join(', ');
      showToast('success', `Added ${names}. ${result.fonts.length === 1 ? 'It stays' : 'They stay'} on this computer.`);
    }
    // A design that was waiting for one of these families can now draw it.
    const doc = selectDoc(store.getState());
    for (const font of result.fonts) {
      forgetFontFamily(font.family);
      const listed = doc && documentFont(doc, font.family);
      if (listed && listed.source !== 'google') {
        const record = { ...documentFontFromLibrary(font), embed: listed.embed && font.embeddable };
        // Usually the file is the very one the design pins, and nothing needs recording.
        if (JSON.stringify(record) !== JSON.stringify(listed)) commitDoc(setDocumentFont(currentDoc(), record), 'Add font file');
      }
    }
    editorRef.current?.refresh();
    return result.fonts;
  } catch (error) {
    showToast('error', isQuotaError(error) ? 'There is not enough storage space to keep that font.' : messageOf(error));
    return [];
  }
}

/**
 * Choose whether a font's files travel inside the project file. Only possible
 * when the font's own permission allows it.
 */
export async function setFontIncluded(family: string, include: boolean): Promise<boolean> {
  const font = documentFont(currentDoc(), family);
  if (!font || font.source === 'google' || font.embed === include) return false;
  if (include && !font.embeddable) {
    showToast('error', `${family} does not allow being put inside files, so only its name is saved.`);
    return false;
  }
  try {
    let next: DocumentFont | null;
    if (font.source === 'installed') next = include ? await embedInstalledFont(font, fonts) : unembedInstalledFont(font);
    else next = { ...font, embed: include };
    if (!next) {
      showToast('error', `${family} could not be read from this computer, so it was not included.`);
      return false;
    }
    return commitDoc(setDocumentFont(currentDoc(), next), include ? 'Include font in project' : 'Stop including font');
  } catch (error) {
    showToast('error', isQuotaError(error) ? 'There is not enough storage space to keep that font.' : messageOf(error));
    return false;
  }
}

/**
 * Fetch a missing family from Google Fonts and use that copy in this design.
 * Works for a Google font whose files are not on this machine, and for any other
 * missing font that Google Fonts also offers under the same name.
 */
export async function getMissingFontFromGoogle(family: string, options: ChooseFontOptions = {}): Promise<boolean> {
  try {
    const entry = await findGoogleFamily(family);
    if (!entry) {
      showToast('error', `Google Fonts does not offer ${family}.`);
      return false;
    }
    const existing = await fonts.getFamily(entry.family);
    const library = existing?.source === 'google' ? existing : await downloadGoogleFamily(entry, fonts, options);
    forgetFontFamily(family);
    const doc = currentDoc();
    const ids = doc.pages.flatMap((page) => page.nodes.filter((node) => node.type === 'text' && node.fontFamily === family).map((node) => node.id));
    const record = documentFontFromLibrary(library);
    const faces = record.faces.map((face) => ({ weight: face.weight, style: face.style }));
    const changed = commitDoc(setTextFont(doc, ids, entry.family, faces, record), 'Download font');
    if (!changed) editorRef.current?.refresh();
    showToast('success', `${entry.family} was downloaded and is ready to use.`);
    return true;
  } catch (error) {
    if (error instanceof FontDownloadError && error.code === 'cancelled') return false;
    showToast('error', isQuotaError(error) ? 'There is not enough storage space to keep that font.' : messageOf(error));
    return false;
  }
}
