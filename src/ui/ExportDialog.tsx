import { motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { EXPORT_WIDTHS, formatSize } from '../document/presets';
import { ExportError, exportHeightFor, MAX_EXPORT_EDGE, type ExportFormat } from '../render/exportPage';
import { exportImage } from '../state/actions';
import { selectPage, showToast, store, useEditor } from '../state/store';
import { Button, ColorField, cx, NumberField } from './controls';

/**
 * Export. The output size is stated in pixels and does not depend on how far the
 * canvas is zoomed or on the screen.
 */
export function ExportDialog() {
  const page = useEditor(selectPage);
  const [format, setFormat] = useState<ExportFormat>('png');
  const [width, setWidth] = useState(page?.width ?? 1280);
  const [quality, setQuality] = useState(90);
  const [limitSize, setLimitSize] = useState(false);
  const [maxMb, setMaxMb] = useState(2);
  const [transparent, setTransparent] = useState(page?.background === null);
  const [flatten, setFlatten] = useState('#ffffff');
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<{ message: string; canContinue: boolean } | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const abort = useRef<AbortController | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const close = () => {
    abort.current?.abort();
    store.setState({ dialog: null });
  };

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('input, button, select')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sizes = useMemo(() => {
    if (!page) return [];
    const widths = [page.width, ...EXPORT_WIDTHS.filter((w) => w !== page.width)];
    return widths.map((w) => ({ width: w, height: exportHeightFor(page, w) }));
  }, [page]);

  if (!page) return null;
  const height = exportHeightFor(page, width);

  const run = async (allowProblems: boolean) => {
    setWorking(true);
    setProblem(null);
    setNotes([]);
    abort.current = new AbortController();
    try {
      const background = format === 'png' ? (transparent ? null : page.background) : (page.background ?? flatten);
      const { result, fileName } = await exportImage({
        format,
        width,
        quality: quality / 100,
        maxBytes: format === 'jpeg' && limitSize ? Math.round(maxMb * 1024 * 1024) : undefined,
        background,
        allowProblems,
        signal: abort.current.signal,
      });
      if (!fileName) return; // the person cancelled the save dialog
      const kb = Math.max(1, Math.round(result.blob.size / 1024));
      if (result.warnings.length) {
        setNotes([`Exported ${fileName} (${formatSize(result.width, result.height)}, ${kb} KB).`, ...result.warnings]);
      } else {
        showToast('success', `Exported ${fileName} (${formatSize(result.width, result.height)}, ${kb} KB)`);
        store.setState({ dialog: null });
      }
    } catch (error) {
      if (error instanceof ExportError) {
        if (error.code === 'cancelled') return;
        setProblem({
          message: error.message,
          canContinue: error.code === 'missing-assets' || error.code === 'missing-fonts',
        });
      } else {
        setProblem({ message: `The export failed. ${error instanceof Error ? error.message : ''}`, canContinue: false });
      }
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/55" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
        initial={{ opacity: 0, scale: 0.97, y: 6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.14, ease: 'easeOut' }}
        className="w-[26rem] rounded-xl bg-panel p-5 shadow-pop"
        data-testid="export-dialog"
      >
        <h2 id="export-title" className="text-[16px] font-semibold text-ink">
          Export image
        </h2>

        <fieldset className="mt-4">
          <legend className="mb-1.5 text-[12px] text-dim">File type</legend>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ['png', 'PNG', 'Sharpest. Can be transparent.'],
                ['jpeg', 'JPG', 'Smaller file. No transparency.'],
              ] as const
            ).map(([value, label, hint]) => (
              <label
                key={value}
                className={cx(
                  'cursor-pointer rounded-md border px-3 py-2 transition-colors',
                  format === value ? 'border-accent bg-accent/15' : 'border-line bg-raised hover:bg-hover',
                )}
              >
                <input type="radio" name="format" value={value} checked={format === value} onChange={() => setFormat(value)} className="sr-only" />
                <span className="block font-medium text-ink">{label}</span>
                <span className="block text-[12px] text-dim">{hint}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="mt-4">
          <legend className="mb-1.5 text-[12px] text-dim">Size in pixels</legend>
          <div className="flex flex-wrap gap-2">
            {sizes.map((size, index) => (
              <button
                key={size.width}
                type="button"
                aria-pressed={width === size.width}
                onClick={() => setWidth(size.width)}
                className={cx(
                  'rounded-md border px-2.5 py-1.5 text-[12px] tabular-nums transition-colors',
                  width === size.width ? 'border-accent bg-accent/15 text-ink' : 'border-line bg-raised text-ink hover:bg-hover',
                )}
              >
                {formatSize(size.width, size.height)}
                {index === 0 && <span className="text-dim"> · page size</span>}
              </button>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <NumberField label="Export width" prefix="W" value={width} min={16} max={MAX_EXPORT_EDGE} digits={0} onCommit={(w) => setWidth(Math.round(w))} className="w-28" />
            <span className="text-dim" data-testid="export-size">
              × {height} px
            </span>
          </div>
        </fieldset>

        {format === 'png' ? (
          <label className="mt-4 flex items-center gap-2 text-ink">
            <input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.currentTarget.checked)} className="h-4 w-4 accent-accent" />
            Transparent background
          </label>
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            <label className="flex items-center gap-2 text-ink">
              <span className="w-16 text-[12px] text-dim">Quality</span>
              <input
                type="range"
                aria-label="JPG quality"
                min={30}
                max={100}
                value={quality}
                onChange={(e) => setQuality(Number(e.currentTarget.value))}
                className="flex-1"
              />
              <span className="w-8 text-right tabular-nums text-dim">{quality}</span>
            </label>
            <div className="flex items-center gap-2 text-ink">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={limitSize} onChange={(e) => setLimitSize(e.currentTarget.checked)} className="h-4 w-4 accent-accent" />
                Keep the file under
              </label>
              <NumberField label="Largest file size in megabytes" value={maxMb} min={0.05} max={100} step={0.5} digits={2} suffix="MB" disabled={!limitSize} onCommit={setMaxMb} className="w-24" />
            </div>
            {page.background === null && (
              <div className="flex items-center gap-2 text-ink">
                <span className="text-[12px] text-dim">JPG cannot be transparent. Fill the background with</span>
                <ColorField label="Background fill colour" value={flatten} onInput={setFlatten} />
              </div>
            )}
          </div>
        )}

        {problem && (
          <div role="alert" className="mt-4 rounded-md border border-danger/50 bg-danger/10 p-3 text-ink">
            <p>{problem.message}</p>
            {problem.canContinue && (
              <Button className="mt-2" disabled={working} onClick={() => void run(true)}>
                Export anyway
              </Button>
            )}
          </div>
        )}
        {notes.length > 0 && (
          <ul role="status" className="mt-4 list-disc rounded-md border border-warn/40 bg-warn/10 py-3 pl-7 pr-3 text-ink">
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            {notes.length ? 'Done' : 'Cancel'}
          </Button>
          <Button variant="primary" disabled={working} onClick={() => void run(false)} data-testid="export-confirm">
            {working ? 'Exporting…' : 'Export'}
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
