import { CircleCheck, Info, Maximize, Minus, Plus, TriangleAlert, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { documentFont } from '../document/ops';
import { formatSize } from '../document/presets';
import { findGoogleFamily } from '../fonts/googleCatalogue';
import { addFontFilesFromPicker, getMissingFontFromGoogle } from '../state/fontActions';
import { editorRef } from '../state/services';
import { dismissToast, selectDoc, selectPage, useEditor } from '../state/store';
import { CanvasView } from './CanvasView';
import { ContextBar } from './ContextBar';
import { cx, IconButton, shortcut } from './controls';
import { ExportDialog } from './ExportDialog';
import { LeftRail } from './LeftRail';
import { RightPanel } from './RightPanel';
import { TopBar } from './TopBar';

const warningButton = 'shrink-0 rounded bg-raised px-2 py-0.5 text-[12px] font-medium text-ink hover:bg-hover disabled:opacity-50';

/** One missing font: why it is missing here, and the quickest way to get it back. */
function MissingFont({ family }: { family: string }) {
  const source = useEditor((s) => {
    const doc = selectDoc(s);
    return doc ? documentFont(doc, family)?.source : undefined;
  });
  const [onGoogle, setOnGoogle] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void findGoogleFamily(family).then((entry) => {
      if (alive) setOnGoogle(!!entry);
    });
    return () => {
      alive = false;
    };
  }, [family]);

  const reason =
    source === 'google'
      ? `The font ${family} has not been downloaded to this computer.`
      : source === 'installed'
        ? `The font ${family} is not installed on this computer.`
        : source === 'file'
          ? `The font file for ${family} is not on this computer.`
          : `The font ${family} is not available.`;

  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="missing-font" data-family={family}>
      <TriangleAlert size={15} className="shrink-0 text-warn" />
      <span>{reason} Text that uses it is shown in a stand-in font and will look different when exported.</span>
      {onGoogle && (
        <button
          type="button"
          disabled={progress !== null}
          data-testid="missing-font-download"
          className={warningButton}
          onClick={async () => {
            setProgress('Downloading…');
            await getMissingFontFromGoogle(family, { onProgress: (done, total) => setProgress(`Downloading ${done} of ${total}…`) });
            setProgress(null);
          }}
        >
          {progress ?? 'Get it from Google Fonts'}
        </button>
      )}
      {source !== 'google' && (
        <button type="button" data-testid="missing-font-add-file" className={warningButton} onClick={() => void addFontFilesFromPicker()}>
          Add its font file…
        </button>
      )}
    </p>
  );
}

/** Problems the person needs to know about. Nothing is substituted or dropped silently. */
function Warnings() {
  const warnings = useEditor((s) => s.warnings);
  const lines: string[] = [];
  if (warnings.missingAssets.length) {
    const n = warnings.missingAssets.length;
    lines.push(
      `${n === 1 ? 'One image is' : `${n} images are`} missing from this project. ${n === 1 ? 'It is' : 'They are'} shown as red placeholders, and export will ask before leaving ${n === 1 ? 'it' : 'them'} out.`,
    );
  }
  if (warnings.openElsewhere) {
    lines.push('This design is also open in another tab or window. Changes made here and there can overwrite each other; close one of them.');
  }
  const missingFamilies = [...new Set(warnings.missingFonts.map((f) => f.family))];
  if (!lines.length && !missingFamilies.length) return null;
  return (
    <div role="alert" className="flex shrink-0 flex-col gap-1 border-b border-warn/40 bg-warn/10 px-3 py-2 text-ink" data-testid="warnings">
      {lines.map((line) => (
        <p key={line} className="flex items-start gap-2">
          <TriangleAlert size={15} className="mt-0.5 shrink-0 text-warn" />
          {line}
        </p>
      ))}
      {missingFamilies.map((family) => (
        <MissingFont key={family} family={family} />
      ))}
    </div>
  );
}

function StatusBar() {
  const zoom = useEditor((s) => s.zoom);
  const page = useEditor(selectPage);
  return (
    <footer className="flex h-8 shrink-0 items-center gap-1 border-t border-line bg-panel px-2 text-[12px] text-dim">
      <IconButton label="Zoom out" keys={shortcut('−', { mod: true })} className="h-6 w-6" onClick={() => editorRef.current?.zoomBy(1 / 1.25)}>
        <Minus size={14} />
      </IconButton>
      <span className="w-11 text-center tabular-nums text-ink" data-testid="zoom-level" aria-label={`Zoom ${Math.round(zoom * 100)} percent`}>
        {Math.round(zoom * 100)}%
      </span>
      <IconButton label="Zoom in" keys={shortcut('+', { mod: true })} className="h-6 w-6" onClick={() => editorRef.current?.zoomBy(1.25)}>
        <Plus size={14} />
      </IconButton>
      <button
        type="button"
        title={`Fit the page in the window (${shortcut('0', { mod: true })})`}
        onClick={() => editorRef.current?.fitPage()}
        className="ml-1 flex h-6 items-center gap-1 rounded px-2 hover:bg-hover hover:text-ink"
      >
        <Maximize size={13} /> Fit
      </button>
      <button
        type="button"
        title={`Actual size (${shortcut('1', { mod: true })})`}
        onClick={() => editorRef.current?.actualSize()}
        className="flex h-6 items-center rounded px-2 hover:bg-hover hover:text-ink"
      >
        100%
      </button>
      <span className="mx-2 h-4 w-px bg-line" aria-hidden />
      {page && <span className="tabular-nums">Page {formatSize(page.width, page.height)} px</span>}
      <span className="flex-1" />
      <span className="hidden lg:inline">Hold Space and drag to move around. Pinch or {shortcut('scroll', { mod: true })} to zoom.</span>
    </footer>
  );
}

/**
 * One message at a time. A new message replaces the old one immediately: removal
 * never waits on an animation, so messages cannot pile up in a background window.
 */
export function Toast() {
  const toast = useEditor((s) => s.toast);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => dismissToast(toast.id), toast.kind === 'error' ? 9000 : 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-12 z-50 flex justify-center px-4">
      {toast && (
        <motion.div
          key={toast.id}
          role={toast.kind === 'error' ? 'alert' : 'status'}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.16 }}
          data-testid="toast"
          data-kind={toast.kind}
          className={cx(
            'pointer-events-auto flex max-w-xl items-start gap-2 rounded-lg bg-raised px-3.5 py-2.5 text-ink shadow-pop',
            toast.kind === 'error' && 'border border-danger/50',
          )}
        >
          {toast.kind === 'error' ? (
            <TriangleAlert size={16} className="mt-0.5 shrink-0 text-danger" />
          ) : toast.kind === 'success' ? (
            <CircleCheck size={16} className="mt-0.5 shrink-0 text-ok" />
          ) : (
            <Info size={16} className="mt-0.5 shrink-0 text-accent" />
          )}
          <span>{toast.message}</span>
          <button type="button" aria-label="Dismiss" onClick={() => dismissToast(toast.id)} className="ml-1 shrink-0 rounded p-0.5 text-dim hover:bg-hover hover:text-ink">
            <X size={14} />
          </button>
        </motion.div>
      )}
    </div>
  );
}

export function Editor() {
  const dialog = useEditor((s) => s.dialog);
  const busy = useEditor((s) => s.busy);
  return (
    <div className="flex h-full flex-col" data-testid="editor" aria-busy={!!busy}>
      <TopBar />
      <ContextBar />
      <Warnings />
      <div className="flex min-h-0 flex-1">
        <LeftRail />
        <main className="relative min-w-0 flex-1" aria-label="Canvas">
          <CanvasView />
        </main>
        <RightPanel />
      </div>
      <StatusBar />
      {dialog === 'export' && <ExportDialog />}
    </div>
  );
}
