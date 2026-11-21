import { motion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatSize } from '../document/presets';
import type { UpscaleMethod } from '../document/types';
import { selectDoc, showToast, store, useEditor } from '../state/store';
import {
  applyUpscale,
  computeUpscale,
  removeUpscale,
  upscaleModelReady,
  upscaleSituation,
  type ComputedUpscale,
  type UpscaleStage,
} from '../state/upscaleActions';
import { UpscaleError } from '../upscale/engine';
import { ModelError, modelDownloadBytes } from '../upscale/model';
import type { UpscaleProvider } from '../upscale/protocol';
import { Button, cx } from './controls';

/**
 * Upscale: make an enlarged, sharper copy of a photo so it holds up at 4K.
 *
 * The original is never replaced. The result is shown next to the original
 * before anything changes, and it can be turned off again at any time.
 */

const megabytes = (bytes: number) => (bytes / 1_000_000).toFixed(1);

/** The middle of the photo at full size: the original on the left of the divider, the enlarged copy on the right. */
function BeforeAfter({ result }: { result: ComputedUpscale }) {
  const box = useRef<HTMLDivElement>(null);
  const beforeRef = useRef<HTMLCanvasElement>(null);
  const afterRef = useRef<HTMLCanvasElement>(null);
  const [split, setSplit] = useState(50);

  useLayoutEffect(() => {
    const host = box.current;
    const beforeCanvas = beforeRef.current;
    const afterCanvas = afterRef.current;
    if (!host || !beforeCanvas || !afterCanvas) return;
    const density = window.devicePixelRatio || 1;
    // One pixel of the enlarged photo per screen pixel, so the difference is honest.
    const width = Math.min(Math.round(host.clientWidth * density), result.after.width);
    const height = Math.min(Math.round(host.clientHeight * density), result.after.height);
    const sx = Math.round((result.after.width - width) / 2);
    const sy = Math.round((result.after.height - height) / 2);
    const scale = result.after.width / result.before.width;
    for (const canvas of [beforeCanvas, afterCanvas]) {
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = `${width / density}px`;
      canvas.style.height = `${height / density}px`;
    }
    afterCanvas.getContext('2d')!.drawImage(result.after, sx, sy, width, height, 0, 0, width, height);
    const context = beforeCanvas.getContext('2d')!;
    // This is how the original looks when it is simply stretched to the same size.
    context.imageSmoothingQuality = 'high';
    context.drawImage(result.before, sx / scale, sy / scale, width / scale, height / scale, 0, 0, width, height);
  }, [result]);

  return (
    <div data-testid="upscale-compare">
      <div ref={box} className="relative flex h-60 items-center justify-center overflow-hidden rounded-md bg-app">
        <div className="relative">
          <canvas ref={beforeRef} className="block" aria-label="The original, stretched to the new size" />
          <canvas
            ref={afterRef}
            className="absolute left-0 top-0 block"
            style={{ clipPath: `inset(0 0 0 ${split}%)` }}
            aria-label="The enlarged copy"
          />
          <span aria-hidden className="absolute bottom-0 top-0 w-0.5 bg-accent" style={{ left: `${split}%` }} />
        </div>
        <span className="absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-ink">Before</span>
        <span className="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-ink">After</span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={split}
        aria-label="Slide to compare before and after"
        data-testid="upscale-compare-slider"
        onChange={(e) => setSplit(Number(e.currentTarget.value))}
        className="mt-2 w-full accent-accent"
      />
    </div>
  );
}

interface Problem {
  message: string;
  /** Offer the plain resize instead. */
  offerPlain: boolean;
}

export function UpscaleDialog() {
  const doc = useEditor(selectDoc);
  const nodeId = useEditor((s) => s.selection[0]);
  const situation = doc && nodeId ? upscaleSituation(doc, nodeId) : null;
  const firstFit = situation?.choices.find((choice) => choice.fits)?.factor ?? null;
  const [factor, setFactor] = useState<2 | 4 | null>(situation?.recommended ?? firstFit);
  const [modelReady, setModelReady] = useState<boolean | null>(null);
  const [stage, setStage] = useState<UpscaleStage | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [provider, setProvider] = useState<UpscaleProvider | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [result, setResult] = useState<ComputedUpscale | null>(null);
  const abort = useRef<AbortController | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const close = () => {
    abort.current?.abort();
    store.setState({ dialog: null });
  };

  useEffect(() => {
    void upscaleModelReady().then(setModelReady);
    dialogRef.current?.querySelector<HTMLElement>('input:not(:disabled), button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      abort.current?.abort();
    };
    // Runs once, when the dialog opens.
  }, []);

  if (!situation || !nodeId) return null;
  const { node, asset } = situation;
  const working = stage !== null;

  const run = async (method: UpscaleMethod) => {
    if (!factor) return;
    setProblem(null);
    setProgress(null);
    setProvider(null);
    setStage(method === 'resample' || modelReady ? 'working' : 'downloading');
    const controller = new AbortController();
    abort.current = controller;
    try {
      const computed = await computeUpscale(nodeId, factor, method, {
        signal: controller.signal,
        onStage: (next) => {
          setStage(next);
          setProgress(null);
        },
        onDownload: (done, total) => setProgress({ done, total }),
        onProgress: (done, total) => setProgress({ done, total }),
        onProvider: setProvider,
      });
      setResult(computed);
      if (method !== 'resample') setModelReady(true);
    } catch (error) {
      if (controller.signal.aborted || (error instanceof UpscaleError && error.code === 'cancelled') || (error instanceof ModelError && error.code === 'cancelled')) {
        // Cancelled: nothing changed, and nothing needs saying.
      } else if (error instanceof ModelError) {
        setProblem({ message: `The enlarging helper could not be downloaded. ${error.message}`, offerPlain: true });
      } else if (error instanceof UpscaleError) {
        setProblem({ message: error.message, offerPlain: error.code === 'failed' && method !== 'resample' });
      } else {
        setProblem({ message: `The photo could not be enlarged. ${error instanceof Error ? error.message : String(error)}`, offerPlain: method !== 'resample' });
      }
    } finally {
      setStage(null);
      setProgress(null);
    }
  };

  const keep = async () => {
    if (!result) return;
    try {
      await applyUpscale(result);
      showToast('success', `Photo enlarged ${result.derived.derivedFrom!.factor} times. The original is kept; turn this off any time from Upscale.`);
      store.setState({ dialog: null });
    } catch {
      setProblem({ message: 'There is not enough storage space on this computer to keep the enlarged photo.', offerPlain: false });
    }
  };

  const percent = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : null;
  const statusText =
    stage === 'downloading'
      ? progress
        ? `Downloading the helper… ${megabytes(progress.done)} of ${megabytes(progress.total)} MB`
        : 'Downloading the helper…'
      : stage === 'working'
        ? progress
          ? `Enlarging… part ${Math.min(progress.done + 1, progress.total)} of ${progress.total}`
          : 'Getting ready…'
        : 'Finishing…';

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/55" onMouseDown={(e) => e.target === e.currentTarget && !working && close()}>
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="upscale-title"
        initial={{ opacity: 0, scale: 0.97, y: 6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.14, ease: 'easeOut' }}
        className="w-[30rem] max-w-[calc(100vw-2rem)] rounded-xl bg-panel p-5 shadow-pop"
        data-testid="upscale-dialog"
      >
        <h2 id="upscale-title" className="text-[16px] font-semibold text-ink">
          Upscale photo
        </h2>

        {result ? (
          <>
            <p className="mt-2 text-dim">
              Now {formatSize(result.derived.width, result.derived.height)} pixels, up from {formatSize(asset.width, asset.height)}.
              {result.derived.derivedFrom!.method === 'resample' && ' This is a plain resize: smoother, but with no new detail.'}
            </p>
            <div className="mt-3">
              <BeforeAfter result={result} />
            </div>
            <p className="mt-1 text-[12px] text-faint">The middle of the photo at full size. Your original is kept either way.</p>
          </>
        ) : working ? (
          <div className="mt-4" role="status" aria-live="polite" data-testid="upscale-progress">
            <p className="text-ink">{statusText}</p>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-raised" role="progressbar" aria-label="Progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
              <div className={cx('h-full rounded-full bg-accent transition-[width]', percent === null && 'w-1/3 animate-pulse')} style={percent === null ? undefined : { width: `${percent}%` }} />
            </div>
            <p className="mt-2 text-[12px] text-dim">
              {provider === 'webgpu' && 'Using the graphics card.'}
              {provider === 'wasm' && 'Using the processor. This is slower and can take a few minutes.'}
              {provider === null && stage === 'working' && 'The first time takes a little longer.'}
            </p>
          </div>
        ) : (
          <>
            <p className="mt-2 text-dim">
              Makes a larger, sharper copy of this photo, worked out on your computer. Your original is kept, and you can turn this off again.
            </p>
            <p className="mt-3 text-ink" data-testid="upscale-situation">
              {node.upscale
                ? `This photo is already enlarged ${node.upscale.factor} times${node.upscale.method === 'resample' ? ' (plain resize)' : ''}. `
                : `The photo is ${formatSize(asset.width, asset.height)} pixels. `}
              {situation.currentStretchAt4k > 150
                ? `Exported at 4K it is stretched to ${Math.round(situation.currentStretchAt4k)}% of its size, so it would look soft.`
                : situation.currentStretchAt4k > 100
                  ? `Exported at 4K it is stretched to ${Math.round(situation.currentStretchAt4k)}% of its size, which usually still looks fine.`
                  : 'It is sharp enough for a 4K export.'}
            </p>

            <fieldset className="mt-4">
              <legend className="mb-1.5 text-[12px] text-dim">Enlarge</legend>
              <div className="grid grid-cols-2 gap-2">
                {situation.choices.map((choice) => (
                  <label
                    key={choice.factor}
                    className={cx(
                      'rounded-md border px-3 py-2 transition-colors',
                      !choice.fits ? 'cursor-not-allowed border-line bg-raised opacity-50' : 'cursor-pointer',
                      choice.fits && (factor === choice.factor ? 'border-accent bg-accent/15' : 'border-line bg-raised hover:bg-hover'),
                    )}
                  >
                    <input
                      type="radio"
                      name="upscale-factor"
                      value={choice.factor}
                      checked={factor === choice.factor}
                      disabled={!choice.fits}
                      onChange={() => setFactor(choice.factor)}
                      className="sr-only"
                      data-testid={`upscale-factor-${choice.factor}`}
                    />
                    <span className="block font-medium text-ink">
                      {choice.factor} times larger
                      {situation.recommended === choice.factor && <span className="ml-1.5 text-[11px] font-normal text-accent">Suggested</span>}
                    </span>
                    <span className="block text-[12px] text-dim">{choice.fits ? `${formatSize(choice.width, choice.height)} pixels` : 'Too large for this photo'}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            {modelReady === false && (
              <p className="mt-3 text-[12px] text-dim" data-testid="upscale-download-note">
                The first time, a {megabytes(modelDownloadBytes())} MB helper is downloaded from huggingface.co. After that it works with no internet.
              </p>
            )}
          </>
        )}

        {problem && (
          <div role="alert" className="mt-4 rounded-md border border-danger/50 bg-danger/10 p-3 text-ink" data-testid="upscale-problem">
            <p>{problem.message}</p>
            {problem.offerPlain && (
              <>
                <p className="mt-2 text-[12px] text-dim">You can still enlarge it with a plain resize. That makes it smoother, but adds no new detail.</p>
                <Button className="mt-2" onClick={() => void run('resample')} data-testid="upscale-plain">
                  Enlarge without adding detail
                </Button>
              </>
            )}
          </div>
        )}

        <div className="mt-5 flex items-center gap-2">
          {!result && !working && node.upscale && (
            <Button
              onClick={() => {
                removeUpscale(nodeId);
                store.setState({ dialog: null });
              }}
              data-testid="upscale-off"
            >
              Turn off and use the original
            </Button>
          )}
          <span className="flex-1" />
          {result ? (
            <>
              <Button variant="ghost" onClick={() => setResult(null)} data-testid="upscale-discard">
                Discard
              </Button>
              <Button variant="primary" onClick={() => void keep()} data-testid="upscale-keep">
                Use this
              </Button>
            </>
          ) : working ? (
            <Button
              onClick={() => abort.current?.abort()}
              data-testid="upscale-cancel"
            >
              Cancel
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={close}>
                Close
              </Button>
              <Button variant="primary" disabled={!factor} onClick={() => void run('realesr-general-x4v3')} data-testid="upscale-start">
                Upscale
              </Button>
            </>
          )}
        </div>
      </motion.div>
    </div>
  );
}
