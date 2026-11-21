import { ImagePlus, RectangleHorizontal, Type, Upload } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { TEXT_PRESET_LABELS, type TextPreset } from '../document/ops';
import { formatSize, PAGE_PRESETS } from '../document/presets';
import type { AssetInfo } from '../document/types';
import { addPhotoFromAsset, addPhotosFromPicker, addText, setPageBackground, setPageSize } from '../state/actions';
import { images } from '../state/services';
import { endGesture, selectDoc, selectPage, store, useEditor, type LeftPanel } from '../state/store';
import { Button, ColorField, cx, NumberField } from './controls';

/**
 * The left rail: labelled buttons that open "add" panels. Everything here adds
 * or changes something with one click; there are no tool modes to learn.
 */

const RAIL: { id: LeftPanel; label: string; icon: ReactNode }[] = [
  { id: 'photos', label: 'Photos', icon: <ImagePlus size={20} /> },
  { id: 'text', label: 'Text', icon: <Type size={20} /> },
  { id: 'page', label: 'Page', icon: <RectangleHorizontal size={20} /> },
];

/** Draws an asset's working preview straight onto a small canvas (no image URLs involved). */
function AssetThumb({ asset }: { asset: AssetInfo }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    void images.getPreview(asset.id).then((preview) => {
      const canvas = ref.current;
      if (cancelled || !canvas || !preview) return;
      const scale = Math.min(1, 240 / preview.element.width);
      canvas.width = Math.max(1, Math.round(preview.element.width * scale));
      canvas.height = Math.max(1, Math.round(preview.element.height * scale));
      canvas.getContext('2d')?.drawImage(preview.element, 0, 0, canvas.width, canvas.height);
    });
    return () => {
      cancelled = true;
    };
  }, [asset.id]);
  return <canvas ref={ref} className="h-full w-full object-cover" aria-hidden />;
}

function PhotosPanel() {
  const assets = useEditor((s) => selectDoc(s)?.assets);
  const list = Object.values(assets ?? {});
  return (
    <div className="flex flex-col gap-3">
      <Button variant="primary" icon={<Upload size={16} />} onClick={() => void addPhotosFromPicker()} className="h-10 w-full" data-testid="add-photo">
        Upload photos
      </Button>
      <p className="text-[12px] text-dim">You can also drop photos onto the page, or paste one you have copied.</p>
      {list.length > 0 && (
        <>
          <h3 className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-faint">In this design</h3>
          <ul className="grid grid-cols-2 gap-2">
            {list.map((asset) => (
              <li key={asset.id}>
                <button
                  type="button"
                  title={`Add ${asset.name} again`}
                  aria-label={`Add ${asset.name} again`}
                  onClick={() => addPhotoFromAsset(asset)}
                  className="block aspect-[4/3] w-full overflow-hidden rounded-md bg-raised ring-accent hover:ring-2"
                >
                  <AssetThumb asset={asset} />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

const PRESET_STYLE: Record<TextPreset, string> = {
  headline: "font-['Anton'] text-[26px] uppercase leading-none tracking-wide",
  heading: "font-['Montserrat'] text-[20px] font-extrabold leading-tight",
  subheading: "font-['Montserrat'] text-[15px] font-semibold",
  body: "font-['Inter'] text-[13px]",
};

function TextPanel() {
  const presets: TextPreset[] = ['headline', 'heading', 'subheading', 'body'];
  return (
    <div className="flex flex-col gap-2">
      {presets.map((preset) => (
        <button
          key={preset}
          type="button"
          onClick={() => addText(preset)}
          data-testid={`add-text-${preset}`}
          className="rounded-md bg-raised px-3 py-3 text-left text-ink transition-colors hover:bg-hover"
        >
          <span className={PRESET_STYLE[preset]}>{TEXT_PRESET_LABELS[preset]}</span>
        </button>
      ))}
      <p className="mt-1 text-[12px] text-dim">Double-click any text on the page to type in it. Press Esc when you are done.</p>
    </div>
  );
}

const BACKGROUNDS = ['#ffffff', '#111111', '#f3f4f6', '#ffd60a', '#ff3b30', '#2563eb', '#16a34a', '#7c3aed'];

function PagePanel() {
  const page = useEditor(selectPage);
  const [custom, setCustom] = useState<{ width: number; height: number } | null>(null);
  if (!page) return null;
  const width = custom?.width ?? page.width;
  const height = custom?.height ?? page.height;
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-faint">Size</h3>
      <ul className="flex flex-col gap-1">
        {PAGE_PRESETS.map((preset) => {
          const current = preset.width === page.width && preset.height === page.height;
          return (
            <li key={preset.id}>
              <button
                type="button"
                aria-pressed={current}
                onClick={() => {
                  setCustom(null);
                  setPageSize(preset.width, preset.height);
                }}
                className={cx(
                  'flex w-full items-center justify-between rounded-md px-3 py-2 text-left transition-colors',
                  current ? 'bg-accent/20 text-ink' : 'bg-raised text-ink hover:bg-hover',
                )}
              >
                <span>{preset.label}</span>
                <span className="text-[12px] tabular-nums text-dim">{formatSize(preset.width, preset.height)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-2">
        <NumberField label="Page width" prefix="W" value={width} min={16} max={8192} digits={0} onCommit={(w) => setCustom({ width: w, height })} />
        <NumberField label="Page height" prefix="H" value={height} min={16} max={8192} digits={0} onCommit={(h) => setCustom({ width, height: h })} />
      </div>
      <Button
        disabled={!custom || (custom.width === page.width && custom.height === page.height)}
        onClick={() => {
          if (custom) setPageSize(Math.round(custom.width), Math.round(custom.height));
          setCustom(null);
        }}
      >
        Use this size
      </Button>
      <p className="text-[12px] text-dim">Changing to a size with the same shape scales your design to fit.</p>

      <h3 className="mt-2 text-[11px] font-semibold uppercase tracking-wider text-faint">Background</h3>
      <div className="flex flex-wrap items-center gap-2">
        {BACKGROUNDS.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={`Background ${color}`}
            aria-pressed={page.background === color}
            title={color}
            onClick={() => setPageBackground(color)}
            className={cx('h-7 w-7 rounded-md border border-line', page.background === color && 'ring-2 ring-accent')}
            style={{ background: color }}
          />
        ))}
        <ColorField
          label="Custom background colour"
          value={page.background ?? '#ffffff'}
          onInput={(color) => setPageBackground(color, 'page-background')}
          onDone={endGesture}
        />
      </div>
      <label className="flex items-center gap-2 text-ink">
        <input
          type="checkbox"
          checked={page.background === null}
          onChange={(e) => setPageBackground(e.currentTarget.checked ? null : '#ffffff')}
          className="h-4 w-4 accent-accent"
        />
        Transparent background
      </label>
    </div>
  );
}

const PANEL_TITLES: Record<LeftPanel, string> = { photos: 'Photos', text: 'Text', page: 'Page' };

export function LeftRail() {
  const open = useEditor((s) => s.leftPanel);
  const toggle = (id: LeftPanel) => store.setState({ leftPanel: open === id ? null : id });

  return (
    <div className="flex h-full shrink-0">
      <nav aria-label="Add to your design" className="flex w-[68px] flex-col items-center gap-1 border-r border-line bg-panel py-2">
        {RAIL.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={open === item.id}
            aria-controls="left-panel"
            onClick={() => toggle(item.id)}
            data-testid={`rail-${item.id}`}
            className={cx(
              'flex h-14 w-14 flex-col items-center justify-center gap-1 rounded-lg text-[11px] transition-colors',
              open === item.id ? 'bg-accent/20 text-ink' : 'text-dim hover:bg-hover hover:text-ink',
            )}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </nav>
      {open && (
        <aside id="left-panel" aria-label={PANEL_TITLES[open]} className="scroll-quiet w-60 overflow-y-auto border-r border-line bg-panel p-3">
          <h2 className="mb-3 text-[14px] font-semibold text-ink">{PANEL_TITLES[open]}</h2>
          {open === 'photos' && <PhotosPanel />}
          {open === 'text' && <TextPanel />}
          {open === 'page' && <PagePanel />}
        </aside>
      )}
    </div>
  );
}
