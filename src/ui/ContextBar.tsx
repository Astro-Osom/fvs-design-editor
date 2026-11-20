import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  Crop,
  FlipHorizontal2,
  FlipVertical2,
  Italic,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { findNode, nearestFace } from '../document/ops';
import { formatSize } from '../document/presets';
import type { DesignNode, ImageNode, TextNode } from '../document/types';
import { availableFaces, WEIGHT_LABELS } from '../render/fonts';
import {
  applyCrop,
  cancelCrop,
  deleteSelection,
  duplicateSelection,
  flipSelection,
  reorderNode,
  startCrop,
  updateSelection,
  updateSelectionLive,
} from '../state/actions';
import { endGesture, selectDoc, selectPage, useEditor } from '../state/store';
import { Button, ColorField, Divider, IconButton, Labelled, NumberField, Select, shortcut } from './controls';
import { FontPicker } from './FontPicker';

/**
 * The contextual toolbar. It shows only the controls that apply to what is
 * selected, so there is nothing to hunt for and nothing that does not work.
 */

function TextControls({ node }: { node: TextNode }) {
  const [more, setMore] = useState(false);
  const doc = useEditor(selectDoc);
  const missing = useEditor((s) => s.warnings.missingFonts.some((font) => font.family === node.fontFamily));
  // Only weights and italics that really exist in this font are offered, so nothing is faked.
  const faces = doc ? availableFaces(doc, node.fontFamily) : [];
  const weightValues = [...new Set(faces.filter((face) => face.style === node.fontStyle).map((face) => face.weight))].sort((a, b) => a - b);
  // A weight the font does not have stays visible until the person changes it.
  if (!weightValues.includes(node.fontWeight)) weightValues.unshift(node.fontWeight);
  const weights = weightValues.map((w) => ({ value: w, label: WEIGHT_LABELS[w] ?? String(w) }));
  const otherStyle = node.fontStyle === 'italic' ? 'normal' : 'italic';
  const otherFace = faces.some((face) => face.style === otherStyle) ? nearestFace(faces, node.fontWeight, otherStyle) : null;

  return (
    <>
      <FontPicker node={node} missing={missing} />
      <NumberField
        label="Text size"
        value={node.fontSize}
        min={4}
        max={2000}
        digits={0}
        suffix="px"
        className="w-20"
        onCommit={(fontSize) => updateSelection({ fontSize }, 'Change text size')}
      />
      {weights.length > 1 && (
        <Select
          label="Weight"
          value={node.fontWeight}
          options={weights}
          onChange={(fontWeight) => updateSelection({ fontWeight }, 'Change weight')}
          className="w-28"
        />
      )}
      {(otherFace || node.fontStyle === 'italic') && (
        <IconButton
          label="Italic"
          active={node.fontStyle === 'italic'}
          disabled={!otherFace}
          onClick={() => otherFace && updateSelection({ fontStyle: otherFace.style, fontWeight: otherFace.weight }, 'Italic')}
        >
          <Italic size={16} />
        </IconButton>
      )}
      <Divider />
      <div role="group" aria-label="Alignment" className="flex">
        {(
          [
            ['left', 'Align left', AlignLeft],
            ['center', 'Align centre', AlignCenter],
            ['right', 'Align right', AlignRight],
          ] as const
        ).map(([align, label, Icon]) => (
          <IconButton key={align} label={label} active={node.align === align} onClick={() => updateSelection({ align }, label)}>
            <Icon size={16} />
          </IconButton>
        ))}
      </div>
      <Divider />
      <Labelled label="Colour">
        <ColorField
          label="Text colour"
          value={node.fill}
          onInput={(fill) => updateSelectionLive({ fill }, 'Change text colour', 'fill')}
          onDone={endGesture}
        />
      </Labelled>
      <Labelled label="Outline">
        <input
          type="checkbox"
          aria-label="Outline"
          checked={!!node.outline}
          onChange={(e) =>
            updateSelection(
              { outline: e.currentTarget.checked ? { color: '#000000', width: Math.max(2, Math.round(node.fontSize * 0.12)) } : null },
              e.currentTarget.checked ? 'Add outline' : 'Remove outline',
            )
          }
          className="h-4 w-4 accent-accent"
        />
        {node.outline && (
          <>
            <ColorField
              label="Outline colour"
              value={node.outline.color}
              onInput={(color) => updateSelectionLive({ outline: { ...node.outline!, color } }, 'Change outline colour', 'outline-color')}
              onDone={endGesture}
            />
            <NumberField
              label="Outline thickness"
              value={node.outline.width}
              min={0}
              max={400}
              digits={0}
              suffix="px"
              className="w-[4.5rem]"
              onCommit={(width) => updateSelection({ outline: { ...node.outline!, width } }, 'Change outline thickness')}
            />
          </>
        )}
      </Labelled>
      <IconButton label="More text options" active={more} onClick={() => setMore((v) => !v)}>
        <SlidersHorizontal size={16} />
      </IconButton>
      {more && (
        <>
          <Labelled label="Line spacing">
            <NumberField
              label="Line spacing"
              value={node.lineHeight}
              min={0.5}
              max={4}
              step={0.05}
              digits={2}
              className="w-16"
              onCommit={(lineHeight) => updateSelection({ lineHeight }, 'Change line spacing')}
            />
          </Labelled>
          <Labelled label="Letter spacing">
            <NumberField
              label="Letter spacing"
              value={node.letterSpacing / 10}
              min={-20}
              max={200}
              digits={0}
              suffix="%"
              className="w-[4.5rem]"
              onCommit={(percent) => updateSelection({ letterSpacing: percent * 10 }, 'Change letter spacing')}
            />
          </Labelled>
        </>
      )}
    </>
  );
}

function ImageControls({ node }: { node: ImageNode }) {
  return (
    <>
      <Button icon={<Crop size={16} />} keys="C" disabled={node.locked} onClick={() => startCrop(node.id)} data-testid="crop-button">
        Crop
      </Button>
      <IconButton label="Flip horizontally" onClick={() => flipSelection('x')}>
        <FlipHorizontal2 size={16} />
      </IconButton>
      <IconButton label="Flip vertically" onClick={() => flipSelection('y')}>
        <FlipVertical2 size={16} />
      </IconButton>
    </>
  );
}

function CommonControls({ nodes }: { nodes: DesignNode[] }) {
  const single = nodes.length === 1 ? nodes[0]! : null;
  const opacity = Math.round((single?.opacity ?? nodes[0]!.opacity) * 100);
  return (
    <>
      <Labelled label="Opacity">
        <input
          type="range"
          aria-label="Opacity"
          min={0}
          max={100}
          value={opacity}
          onInput={(e) => updateSelectionLive({ opacity: Number(e.currentTarget.value) / 100 }, 'Change opacity', 'opacity')}
          onChange={() => undefined}
          onPointerUp={endGesture}
          onKeyUp={endGesture}
          onBlur={endGesture}
          className="w-24"
        />
        <span className="w-9 text-right text-[12px] tabular-nums text-dim">{opacity}%</span>
      </Labelled>
      <div className="flex-1" />
      {single && (
        <>
          <IconButton label="Bring forward" keys={shortcut(']', { mod: true })} onClick={() => reorderNode(single.id, 'forward')}>
            <ArrowUp size={16} />
          </IconButton>
          <IconButton label="Send backward" keys={shortcut('[', { mod: true })} onClick={() => reorderNode(single.id, 'backward')}>
            <ArrowDown size={16} />
          </IconButton>
        </>
      )}
      <IconButton label="Duplicate" keys={shortcut('D', { mod: true })} onClick={duplicateSelection}>
        <Copy size={16} />
      </IconButton>
      <IconButton label="Delete" keys="Delete" onClick={deleteSelection} data-testid="delete-button">
        <Trash2 size={16} />
      </IconButton>
    </>
  );
}

export function ContextBar() {
  const doc = useEditor(selectDoc);
  const page = useEditor(selectPage);
  const selection = useEditor((s) => s.selection);
  const cropping = useEditor((s) => s.cropNodeId !== null);
  const editingText = useEditor((s) => s.editingText);

  const nodes = doc ? selection.flatMap((id) => findNode(doc, id)?.node ?? []) : [];
  const single = nodes.length === 1 ? nodes[0]! : null;

  let content;
  if (cropping) {
    content = (
      <>
        <span className="text-ink">Drag the frame to choose what to keep. The rest of the photo is kept, so you can change this later.</span>
        <div className="flex-1" />
        <Button icon={<X size={16} />} keys="Esc" onClick={cancelCrop} data-testid="crop-cancel">
          Cancel
        </Button>
        <Button variant="primary" icon={<Check size={16} />} keys="Enter" onClick={applyCrop} data-testid="crop-apply">
          Apply crop
        </Button>
      </>
    );
  } else if (nodes.length === 0) {
    content = (
      <span className="text-dim">
        {page ? `Page ${formatSize(page.width, page.height)} px.` : ''} Click something on the page to change it, or add a photo or
        text from the left.
      </span>
    );
  } else {
    content = (
      <>
        {single?.type === 'text' && <TextControls node={single} />}
        {single?.type === 'image' && <ImageControls node={single} />}
        {!single && <span className="text-dim">{nodes.length} layers selected</span>}
        <Divider />
        <CommonControls nodes={nodes} />
      </>
    );
  }

  return (
    <div
      role="toolbar"
      aria-label={cropping ? 'Crop' : 'Options for the selection'}
      className="scroll-quiet flex h-11 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-line bg-panel px-3"
      data-testid="context-bar"
      data-editing-text={editingText ? 'true' : 'false'}
    >
      {content}
    </div>
  );
}
