import { Check, ChevronDown, CloudDownload, FilePlus2, LoaderCircle, Monitor, Search, X } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { documentFont, fontsUsed } from '../document/ops';
import type { DesignDocument, TextNode } from '../document/types';
import type { LibraryFont } from '../fonts/fontStore';
import { loadGoogleCatalogue, searchFamilies, type CatalogueFamily, type GoogleCategory } from '../fonts/googleCatalogue';
import { listLocalFamilies, localFontsPermission, type LocalFamily } from '../fonts/localFonts';
import { previewGoogleFamily, previewLibraryFont, previewLocalFamily } from '../render/fontPreview';
import { BUNDLED_FONTS, isBundledFamily } from '../render/fonts';
import { addFontFilesFromPicker, chooseFont, setFontIncluded, type FontChoice } from '../state/fontActions';
import { fonts } from '../state/services';
import { selectDoc, useEditor } from '../state/store';
import { cx } from './controls';

/**
 * The font menu: one searchable list of every font that can be used, grouped by
 * where it comes from, with each name shown in its own font.
 *
 * - In this design: fonts the design already uses.
 * - Built in: ships with the editor, works everywhere.
 * - Added and downloaded: already on this machine.
 * - On this computer: installed fonts, listed after the person allows it.
 * - Google Fonts: downloaded the first time one is used.
 */

type Group = 'design' | 'builtin' | 'library' | 'installed' | 'google';
type Filter = 'all' | Group;

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'design', label: 'In this design' },
  { id: 'builtin', label: 'Built in' },
  { id: 'library', label: 'Added' },
  { id: 'installed', label: 'This computer' },
  { id: 'google', label: 'Google' },
];

const CATEGORIES: { id: GoogleCategory | 'all'; label: string }[] = [
  { id: 'all', label: 'Any style' },
  { id: 'Sans Serif', label: 'Sans serif' },
  { id: 'Serif', label: 'Serif' },
  { id: 'Display', label: 'Display' },
  { id: 'Handwriting', label: 'Handwriting' },
  { id: 'Monospace', label: 'Monospace' },
];

type Preview =
  | { kind: 'direct' }
  | { kind: 'library'; font: LibraryFont }
  | { kind: 'local'; family: LocalFamily }
  | { kind: 'google' };

type Row =
  | { kind: 'header'; key: string; label: string; hint?: string }
  | { kind: 'font'; key: string; group: Group; family: string; tag?: string; choice: FontChoice; preview: Preview }
  | { kind: 'button'; key: string; label: string; icon: 'computer' | 'file'; action: 'list-installed' | 'add-file' }
  | { kind: 'note'; key: string; text: string };

type LocalState =
  | { status: 'unknown' | 'ask' | 'loading' | 'denied' | 'unsupported' }
  | { status: 'ready'; families: LocalFamily[] };

// The list of installed fonts is read once and remembered while the app is open.
// Reading it can take half a minute on a computer with many fonts, and the desktop
// app cannot quit until a reading in progress has finished. So it only ever starts
// when the person asks for it, and it lives outside the menu so that it carries on
// if the menu closes.
let localMemory: LocalState = { status: 'unknown' };
const localListeners = new Set<() => void>();

function setLocalMemory(next: LocalState): void {
  localMemory = next;
  for (const listener of localListeners) listener();
}

function subscribeLocal(listener: () => void): () => void {
  localListeners.add(listener);
  return () => localListeners.delete(listener);
}

async function listInstalledFonts(): Promise<void> {
  if (localMemory.status === 'loading') return;
  setLocalMemory({ status: 'loading' });
  try {
    setLocalMemory({ status: 'ready', families: await listLocalFamilies() });
  } catch {
    setLocalMemory({ status: 'denied' });
  }
}

/** Find out whether installed fonts can be listed here at all. Listing itself waits to be asked for. */
async function checkInstalledFonts(): Promise<void> {
  if (localMemory.status !== 'unknown') return;
  const permission = await localFontsPermission();
  if (localMemory.status !== 'unknown') return;
  setLocalMemory({ status: permission === 'granted' || permission === 'prompt' ? 'ask' : permission });
}

const ROW_HEIGHT = 34;
const PREVIEWS_KEY = 'fvs.googleFontPreviews';

const SOURCE_TAGS = { google: 'Google', installed: 'This computer', file: 'Your file' } as const;

function readPreviewsSetting(): boolean {
  try {
    return localStorage.getItem(PREVIEWS_KEY) === 'on';
  } catch {
    return false;
  }
}

/** The person asked for the fonts on this computer. */
async function requestInstalledFonts(): Promise<void> {
  await checkInstalledFonts();
  if (localMemory.status === 'ask') await listInstalledFonts();
}

function buildRows(input: {
  doc: DesignDocument;
  query: string;
  filter: Filter;
  category: GoogleCategory | 'all';
  library: LibraryFont[];
  catalogue: CatalogueFamily[] | null;
  local: LocalState;
}): Row[] {
  const { doc, query, filter, category, library, catalogue, local } = input;
  const rows: Row[] = [];
  const show = (group: Group) => filter === 'all' || filter === group;
  const section = (group: Group, label: string, items: Row[], hint?: string) => {
    if (!show(group) || !items.length) return;
    rows.push({ kind: 'header', key: `h:${group}`, label, ...(hint ? { hint } : {}) }, ...items);
  };

  const used = [...new Set(fontsUsed(doc).map((use) => use.family))];
  const usedSet = new Set(used);
  section(
    'design',
    'In this design',
    searchFamilies(
      used.map((family) => ({ family })),
      query,
    ).map(({ family }): Row => {
      const font = documentFont(doc, family);
      return {
        kind: 'font',
        key: `design:${family}`,
        group: 'design',
        family,
        tag: font ? SOURCE_TAGS[font.source] : isBundledFamily(family) ? 'Built in' : 'Missing',
        choice: { kind: 'design', family },
        preview: { kind: 'direct' },
      };
    }),
  );

  section(
    'builtin',
    'Built in',
    searchFamilies(
      BUNDLED_FONTS.filter((font) => !usedSet.has(font.family)),
      query,
    ).map((font): Row => ({
      kind: 'font',
      key: `builtin:${font.family}`,
      group: 'builtin',
      family: font.family,
      choice: { kind: 'builtin', family: font.family },
      preview: { kind: 'direct' },
    })),
  );

  const libraryNames = new Set(library.map((font) => font.family));
  section(
    'library',
    'Added and downloaded',
    searchFamilies(
      library.filter((font) => !usedSet.has(font.family) && !isBundledFamily(font.family)).sort((a, b) => a.family.localeCompare(b.family)),
      query,
    ).map((font): Row => ({
      kind: 'font',
      key: `library:${font.family}`,
      group: 'library',
      family: font.family,
      tag: font.source === 'google' ? 'Google' : 'Your file',
      choice: { kind: 'library', font },
      preview: { kind: 'library', font },
    })),
  );

  if (show('installed')) {
    const items: Row[] = [];
    if (local.status === 'ready') {
      for (const family of searchFamilies(
        local.families.filter((f) => !isBundledFamily(f.family) && documentFont(doc, f.family)?.source !== 'installed'),
        query,
      )) {
        items.push({
          kind: 'font',
          key: `installed:${family.family}`,
          group: 'installed',
          family: family.family,
          choice: { kind: 'installed', family },
          preview: { kind: 'local', family },
        });
      }
    } else if (!query || filter === 'installed') {
      if (local.status === 'ask') items.push({ kind: 'button', key: 'b:installed', label: 'Show the fonts on this computer', icon: 'computer', action: 'list-installed' });
      else if (local.status === 'loading') items.push({ kind: 'note', key: 'n:installed', text: 'Looking for fonts… The first time can take a minute.' });
      else if (local.status === 'unknown') items.push({ kind: 'note', key: 'n:installed', text: 'Checking…' });
      else if (local.status === 'denied') items.push({ kind: 'note', key: 'n:installed', text: 'Listing was not allowed. Add a font file instead.' });
      else items.push({ kind: 'note', key: 'n:installed', text: 'Not possible in this browser. Add a font file instead.' });
    }
    section('installed', 'On this computer', items, local.status === 'ready' ? 'Stay on this computer' : undefined);
  }

  if (show('google')) {
    const items: Row[] = [];
    if (!catalogue) items.push({ kind: 'note', key: 'n:google', text: 'Loading the list…' });
    else {
      for (const entry of searchFamilies(
        catalogue.filter(
          (e) => !usedSet.has(e.family) && !libraryNames.has(e.family) && !isBundledFamily(e.family) && (category === 'all' || e.category === category),
        ),
        query,
      )) {
        items.push({
          kind: 'font',
          key: `google:${entry.family}`,
          group: 'google',
          family: entry.family,
          ...(entry.large ? { tag: 'Large download' } : {}),
          choice: { kind: 'google', entry },
          preview: { kind: 'google' },
        });
      }
    }
    section('google', 'Google Fonts', items, 'Downloaded when first used');
  }
  return rows;
}

function FontName({ row, googlePreviews }: { row: Extract<Row, { kind: 'font' }>; googlePreviews: boolean }) {
  const direct = row.preview.kind === 'direct';
  const [alias, setAlias] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const preview = row.preview;
    const pending =
      preview.kind === 'library'
        ? previewLibraryFont(preview.font)
        : preview.kind === 'local'
          ? previewLocalFamily(preview.family)
          : preview.kind === 'google' && googlePreviews
            ? previewGoogleFamily(row.family)
            : null;
    setAlias(null);
    void pending?.then((name) => {
      if (alive) setAlias(name);
    });
    return () => {
      alive = false;
    };
    // The row's key identifies its preview, so it stands in for the row here.
  }, [row.key, googlePreviews]);
  const family = direct ? row.family : alias;
  return (
    <span className="min-w-0 flex-1 truncate text-[15px] leading-none" style={family ? { fontFamily: `"${family}", var(--font-sans)` } : undefined}>
      {row.family}
    </span>
  );
}

interface Pending {
  key: string;
  family: string;
  done: number;
  total: number;
  controller: AbortController | null;
}

export function FontPicker({ node, missing }: { node: TextNode; missing: boolean }) {
  const doc = useEditor(selectDoc);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [category, setCategory] = useState<GoogleCategory | 'all'>('all');
  const [library, setLibrary] = useState<LibraryFont[]>([]);
  const [catalogue, setCatalogue] = useState<CatalogueFamily[] | null>(null);
  const local = useSyncExternalStore(subscribeLocal, () => localMemory);
  const [googlePreviews, setGooglePreviews] = useState(readPreviewsSetting);
  const [pending, setPending] = useState<Pending | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [listHeight, setListHeight] = useState(320);
  const [place, setPlace] = useState({ left: 0, top: 0, height: 480 });

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const refreshLibrary = useCallback(() => {
    void fonts
      .listFamilies()
      .then(setLibrary)
      .catch(() => setLibrary([]));
  }, []);

  // Load what the list needs when it opens.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void checkInstalledFonts();
    refreshLibrary();
    void loadGoogleCatalogue().then((list) => {
      if (alive) setCatalogue(list);
    });
    return () => {
      alive = false;
    };
  }, [open, refreshLibrary]);

  // Keep the panel under the button, inside the window.
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const top = rect.bottom + 6;
      setPlace({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 388)),
        top,
        height: Math.max(260, Math.min(600, window.innerHeight - top - 12)),
      });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [open]);

  // The list fills whatever room is left in the panel; only the rows in view are drawn.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!open || !list) return;
    const observer = new ResizeObserver(() => setListHeight(list.clientHeight));
    observer.observe(list);
    setListHeight(list.clientHeight);
    return () => observer.disconnect();
  }, [open]);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setQuery('');
    if (refocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    inputRef.current?.focus();
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, close]);

  // A download that is still running when the menu goes away is cancelled.
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;
  useEffect(() => () => pendingRef.current?.controller?.abort(), []);

  const rows = useMemo(
    () => (open && doc ? buildRows({ doc, query, filter, category, library, catalogue, local }) : []),
    [open, doc, query, filter, category, library, catalogue, local],
  );
  const selectable = useMemo(() => rows.filter((row) => row.kind === 'font' || row.kind === 'button'), [rows]);
  const active = selectable.find((row) => row.key === activeKey) ?? selectable[0] ?? null;

  const scrollToRow = useCallback(
    (key: string) => {
      const list = listRef.current;
      const index = rows.findIndex((row) => row.key === key);
      if (!list || index < 0) return;
      const top = index * ROW_HEIGHT;
      if (top < list.scrollTop) list.scrollTop = Math.max(0, top - ROW_HEIGHT);
      else if (top + ROW_HEIGHT > list.scrollTop + list.clientHeight) list.scrollTop = top + ROW_HEIGHT - list.clientHeight;
    },
    [rows],
  );

  // A new search starts from the top.
  useEffect(() => {
    setActiveKey(null);
    if (listRef.current) listRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [query, filter, category]);

  const activate = useCallback(
    async (row: Row) => {
      if (pending) return;
      if (row.kind === 'button') {
        if (row.action === 'list-installed') await requestInstalledFonts();
        return;
      }
      if (row.kind !== 'font') return;
      const downloads = row.choice.kind === 'google';
      const controller = downloads ? new AbortController() : null;
      setPending({ key: row.key, family: row.family, done: 0, total: 0, controller });
      const changed = await chooseFont(row.choice, {
        ...(controller ? { signal: controller.signal } : {}),
        onProgress: (done, total) => setPending((current) => (current?.key === row.key ? { ...current, done, total } : current)),
      });
      setPending(null);
      if (downloads) refreshLibrary();
      if (changed) setActiveKey(`design:${row.family}`);
      inputRef.current?.focus();
    },
    [pending, refreshLibrary],
  );

  const addFile = useCallback(async () => {
    const added = await addFontFilesFromPicker();
    refreshLibrary();
    if (added[0]) await chooseFont({ kind: 'library', font: added[0] });
    inputRef.current?.focus();
  }, [refreshLibrary]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (active) void activate(active);
      return;
    }
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : event.key === 'PageDown' ? 8 : event.key === 'PageUp' ? -8 : 0;
    if (!step || !selectable.length) return;
    event.preventDefault();
    const current = active ? selectable.indexOf(active) : -1;
    const next = selectable[Math.min(selectable.length - 1, Math.max(0, current + step))]!;
    setActiveKey(next.key);
    scrollToRow(next.key);
  };

  const current = doc ? documentFont(doc, node.fontFamily) : undefined;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 4);
  const last = Math.min(rows.length, Math.ceil((scrollTop + listHeight) / ROW_HEIGHT) + 4);
  const optionId = (key: string) => `${listId}-${key.replace(/[^a-zA-Z0-9]/g, '_')}`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label="Font"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Font"
        data-testid="font-button"
        data-family={node.fontFamily}
        onClick={() => (open ? close(false) : setOpen(true))}
        className="flex h-8 w-44 min-w-0 shrink-0 items-center gap-1 rounded-md bg-raised px-2 text-left text-[13px] text-ink hover:bg-hover"
      >
        <span className="min-w-0 flex-1 truncate" style={missing ? undefined : { fontFamily: `"${node.fontFamily}", var(--font-sans)` }}>
          {node.fontFamily}
          {missing && <span className="text-warn"> (missing)</span>}
        </span>
        <ChevronDown size={14} className="shrink-0 text-dim" />
      </button>
      {open &&
        doc &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Fonts"
            data-testid="font-picker"
            style={{ left: place.left, top: place.top, height: place.height }}
            className="fixed z-40 flex w-[380px] flex-col overflow-hidden rounded-lg bg-panel text-ink shadow-pop"
          >
            <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
              <Search size={15} className="shrink-0 text-dim" />
              <input
                ref={inputRef}
                type="text"
                role="combobox"
                aria-label="Search fonts"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={active ? optionId(active.key) : undefined}
                aria-autocomplete="list"
                placeholder="Search fonts"
                spellCheck={false}
                autoComplete="off"
                value={query}
                data-testid="font-search"
                onChange={(e) => setQuery(e.currentTarget.value)}
                onKeyDown={onKeyDown}
                className="h-7 min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-faint"
              />
              <button type="button" aria-label="Close the font list" title="Close (Esc)" onClick={() => close(true)} className="rounded p-1 text-dim hover:bg-hover hover:text-ink">
                <X size={14} />
              </button>
            </div>

            <div role="group" aria-label="Show fonts from" className="scroll-quiet flex shrink-0 gap-1 overflow-x-auto px-2 py-2">
              {FILTERS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={filter === item.id}
                  data-testid={`font-filter-${item.id}`}
                  onClick={() => {
                    setFilter(item.id);
                    // Choosing "This computer" is asking for the installed fonts.
                    if (item.id === 'installed') void requestInstalledFonts();
                  }}
                  className={cx(
                    'h-6 shrink-0 rounded-full px-2.5 text-[12px] transition-colors',
                    filter === item.id ? 'bg-accent/20 text-accent' : 'bg-raised text-dim hover:bg-hover hover:text-ink',
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
            {filter === 'google' && (
              <div className="flex h-[34px] shrink-0 items-center gap-2 px-3">
                <label htmlFor={`${listId}-category`} className="text-[12px] text-dim">
                  Style
                </label>
                <select
                  id={`${listId}-category`}
                  value={category}
                  data-testid="font-category"
                  onChange={(e) => setCategory(e.currentTarget.value as GoogleCategory | 'all')}
                  className="h-6 rounded bg-raised px-1.5 text-[12px] text-ink outline-none hover:bg-hover"
                >
                  {CATEGORIES.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {current && current.source !== 'google' && (
              <label className="flex min-h-11 shrink-0 items-center gap-2 border-y border-line bg-raised/50 px-3 py-1.5 text-[12px] text-dim" data-testid="font-include-row">
                {current.embeddable ? (
                  <>
                    <input
                      type="checkbox"
                      checked={current.embed}
                      data-testid="font-include"
                      onChange={(e) => void setFontIncluded(current.family, e.currentTarget.checked)}
                      className="h-4 w-4 shrink-0 accent-accent"
                    />
                    <span>
                      Put <span className="text-ink">{current.family}</span> inside the project file, so it opens on other computers. Only for fonts you may share.
                    </span>
                  </>
                ) : (
                  <span>
                    <span className="text-ink">{current.family}</span> does not allow being put inside files. Other computers need it installed.
                  </span>
                )}
              </label>
            )}

            <div
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label="Fonts"
              onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
              className="scroll-quiet min-h-0 flex-1 overflow-y-auto"
              data-testid="font-list"
            >
              <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
                {rows.slice(first, last).map((row, offset) => {
                  const top = (first + offset) * ROW_HEIGHT;
                  const style = { position: 'absolute' as const, top, left: 0, right: 0, height: ROW_HEIGHT };
                  if (row.kind === 'header') {
                    return (
                      <div key={row.key} role="presentation" style={style} className="flex items-end justify-between px-3 pb-1.5">
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">{row.label}</span>
                        {row.hint && <span className="text-[11px] text-faint">{row.hint}</span>}
                      </div>
                    );
                  }
                  if (row.kind === 'note') {
                    return (
                      <div key={row.key} role="presentation" style={style} className="flex items-center px-3 text-[12px] text-dim">
                        <span className="truncate">{row.text}</span>
                      </div>
                    );
                  }
                  const isActive = active?.key === row.key;
                  if (row.kind === 'button') {
                    return (
                      <div
                        key={row.key}
                        id={optionId(row.key)}
                        role="option"
                        aria-selected={false}
                        style={style}
                        data-testid={`font-action-${row.action}`}
                        onClick={() => void activate(row)}
                        onPointerMove={() => setActiveKey(row.key)}
                        className={cx('flex items-center gap-2 px-3 text-[13px] text-accent', isActive && 'bg-hover')}
                      >
                        {row.icon === 'computer' ? <Monitor size={15} /> : <FilePlus2 size={15} />}
                        {row.label}
                      </div>
                    );
                  }
                  const isCurrent = row.group === 'design' && row.family === node.fontFamily;
                  const busy = pending?.key === row.key;
                  return (
                    <div
                      key={row.key}
                      id={optionId(row.key)}
                      role="option"
                      aria-selected={isCurrent}
                      aria-disabled={!!pending && !busy}
                      style={style}
                      data-testid="font-option"
                      data-family={row.family}
                      data-group={row.group}
                      onClick={() => void activate(row)}
                      onPointerMove={() => setActiveKey(row.key)}
                      className={cx('flex items-center gap-2 px-3', isActive && 'bg-hover', pending && !busy && 'opacity-50')}
                    >
                      <span className="flex w-4 shrink-0 justify-center text-accent">{isCurrent && <Check size={14} aria-label="Current font" />}</span>
                      <FontName row={row} googlePreviews={googlePreviews} />
                      {busy ? (
                        <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-dim" data-testid="font-progress">
                          <LoaderCircle size={13} className="animate-spin" />
                          {pending.total > 0 ? `${pending.done} of ${pending.total}` : row.group === 'google' ? 'Downloading' : 'Reading'}
                          {pending.controller && (
                            <button
                              type="button"
                              aria-label={`Cancel downloading ${row.family}`}
                              title="Cancel"
                              onClick={(e) => {
                                e.stopPropagation();
                                pending.controller?.abort();
                              }}
                              className="rounded p-0.5 hover:bg-raised hover:text-ink"
                            >
                              <X size={12} />
                            </button>
                          )}
                        </span>
                      ) : (
                        <>
                          {row.tag && <span className="shrink-0 text-[11px] text-faint">{row.tag}</span>}
                          {row.group === 'google' && <CloudDownload size={14} className="shrink-0 text-faint" aria-label="Downloads from Google Fonts" />}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
              {rows.length === 0 && <p className="px-3 py-6 text-center text-[12px] text-dim">No font matches “{query.trim()}”.</p>}
            </div>

            <div className="flex shrink-0 flex-col gap-2 border-t border-line px-3 py-2">
              <label className="flex items-center gap-2 text-[12px] text-dim">
                <input
                  type="checkbox"
                  checked={googlePreviews}
                  data-testid="font-previews-toggle"
                  onChange={(e) => {
                    const on = e.currentTarget.checked;
                    setGooglePreviews(on);
                    try {
                      localStorage.setItem(PREVIEWS_KEY, on ? 'on' : 'off');
                    } catch {
                      // The choice simply is not remembered.
                    }
                  }}
                  className="h-4 w-4 shrink-0 accent-accent"
                />
                <span>Show Google fonts in their own lettering (loads small samples from Google)</span>
              </label>
              <button
                type="button"
                data-testid="font-add-file"
                onClick={() => void addFile()}
                className="flex h-8 items-center justify-center gap-1.5 rounded-md bg-raised text-[13px] font-medium text-ink hover:bg-hover"
              >
                <FilePlus2 size={15} />
                Add a font file…
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
