import { Eye, EyeOff, Image as ImageIcon, Link2, Lock, LockOpen, Type, Unlink2 } from 'lucide-react';
import { useState } from 'react';
import { findNode, nodeLabel } from '../document/ops';
import type { DesignNode } from '../document/types';
import { updateNodesById, updateSelection } from '../state/actions';
import { jumpToHistory, selectDoc, selectPage, setSelection, store, useEditor } from '../state/store';
import { cx, IconButton, NumberField, PanelSection } from './controls';

/** Layers, exact position and size, and the history list. */

function LayerRow({ node, selected }: { node: DesignNode; selected: boolean }) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const label = nodeLabel(node);

  const select = (additive: boolean) => {
    const { selection } = store.getState();
    if (additive) setSelection(selected ? selection.filter((id) => id !== node.id) : [...selection, node.id]);
    else setSelection([node.id]);
  };

  return (
    <li
      role="option"
      aria-selected={selected}
      aria-label={`${label}${node.visible ? '' : ', hidden'}${node.locked ? ', locked' : ''}`}
      tabIndex={0}
      data-testid="layer-row"
      data-node-id={node.id}
      onClick={(e) => select(e.shiftKey || e.metaKey || e.ctrlKey)}
      onDoubleClick={() => {
        setDraft(label);
        setRenaming(true);
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          select(e.shiftKey);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const sibling = e.key === 'ArrowDown' ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling;
          (sibling as HTMLElement | null)?.focus();
        } else if (e.key === 'F2') {
          setDraft(label);
          setRenaming(true);
        }
      }}
      className={cx(
        'group flex h-9 items-center gap-1 rounded-md px-1.5 transition-colors',
        selected ? 'bg-accent/20' : 'hover:bg-hover',
        !node.visible && 'opacity-60',
      )}
    >
      <IconButton
        label={node.visible ? 'Hide layer' : 'Show layer'}
        className="h-7 w-7"
        onClick={(e) => {
          e.stopPropagation();
          updateNodesById([node.id], { visible: !node.visible }, node.visible ? 'Hide layer' : 'Show layer');
        }}
      >
        {node.visible ? <Eye size={15} /> : <EyeOff size={15} />}
      </IconButton>
      <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center text-dim">
        {node.type === 'image' ? <ImageIcon size={15} /> : <Type size={15} />}
      </span>
      {renaming ? (
        <input
          autoFocus
          aria-label="Layer name"
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={() => {
            setRenaming(false);
            if (draft.trim() !== label) updateNodesById([node.id], { name: draft.trim() }, 'Rename layer');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              setDraft(label);
              setRenaming(false);
            }
          }}
          className="h-7 min-w-0 flex-1 rounded bg-app px-1.5 text-[13px] text-ink outline-none"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate text-ink" title="Double-click to rename">
          {label}
        </span>
      )}
      <IconButton
        label={node.locked ? 'Unlock layer' : 'Lock layer'}
        className={cx('h-7 w-7', !node.locked && !selected && 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100')}
        onClick={(e) => {
          e.stopPropagation();
          updateNodesById([node.id], { locked: !node.locked }, node.locked ? 'Unlock layer' : 'Lock layer');
        }}
      >
        {node.locked ? <Lock size={14} /> : <LockOpen size={14} />}
      </IconButton>
    </li>
  );
}

function Layers() {
  const page = useEditor(selectPage);
  const selection = useEditor((s) => s.selection);
  // Top-most layer first, the way they are stacked on the page.
  const nodes = page ? page.nodes.slice().reverse() : [];
  return (
    <PanelSection title="Layers" className="min-h-0 flex-1">
      {nodes.length === 0 ? (
        <p className="px-3 pb-3 text-[12px] text-dim">Everything you add appears here, top-most first.</p>
      ) : (
        <ul role="listbox" aria-label="Layers" aria-multiselectable className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-1.5 pb-2" data-testid="layers">
          {nodes.map((node) => (
            <LayerRow key={node.id} node={node} selected={selection.includes(node.id)} />
          ))}
        </ul>
      )}
    </PanelSection>
  );
}

function Position() {
  const doc = useEditor(selectDoc);
  const selection = useEditor((s) => s.selection);
  const [locked, setLocked] = useState(true);
  const node = doc && selection.length === 1 ? findNode(doc, selection[0]!)?.node : undefined;

  if (!node) {
    return (
      <PanelSection title="Position">
        <p className="px-3 pb-3 text-[12px] text-dim">
          {selection.length > 1 ? 'Select a single layer to set its exact position and size.' : 'Select a layer to set its exact position and size.'}
        </p>
      </PanelSection>
    );
  }
  const disabled = node.locked;
  return (
    <PanelSection title="Position">
      <div className="grid grid-cols-2 gap-2 px-3 pb-3" data-testid="position-panel">
        <NumberField label="X position" prefix="X" value={node.x} disabled={disabled} onCommit={(x) => updateSelection({ x }, 'Move layer')} />
        <NumberField label="Y position" prefix="Y" value={node.y} disabled={disabled} onCommit={(y) => updateSelection({ y }, 'Move layer')} />
        <NumberField
          label="Width"
          prefix="W"
          value={node.width}
          min={1}
          disabled={disabled}
          onCommit={(width) =>
            updateSelection(
              node.type === 'image' && locked ? { width, height: (width * node.height) / node.width } : { width },
              'Resize layer',
            )
          }
        />
        {node.type === 'image' ? (
          <div className="flex items-center gap-1">
            <NumberField
              label="Height"
              prefix="H"
              value={node.height}
              min={1}
              disabled={disabled}
              onCommit={(height) =>
                updateSelection(locked ? { height, width: (height * node.width) / node.height } : { height }, 'Resize layer')
              }
            />
            <IconButton
              label={locked ? 'Proportions are locked' : 'Proportions are unlocked'}
              active={locked}
              className="h-8 w-7"
              onClick={() => setLocked((v) => !v)}
            >
              {locked ? <Link2 size={14} /> : <Unlink2 size={14} />}
            </IconButton>
          </div>
        ) : (
          <span className="flex h-8 items-center px-2 text-[12px] text-faint">Height follows the text</span>
        )}
        <NumberField
          label="Rotation"
          prefix="R"
          suffix="°"
          value={node.rotation}
          min={-360}
          max={360}
          disabled={disabled}
          onCommit={(rotation) => updateSelection({ rotation }, 'Rotate layer')}
        />
        <NumberField
          label="Opacity"
          prefix="O"
          suffix="%"
          value={node.opacity * 100}
          min={0}
          max={100}
          digits={0}
          disabled={disabled}
          onCommit={(percent) => updateSelection({ opacity: percent / 100 }, 'Change opacity')}
        />
      </div>
    </PanelSection>
  );
}

function HistoryList() {
  const history = useEditor((s) => s.history);
  const [open, setOpen] = useState(false);
  if (!history) return null;
  return (
    <PanelSection
      title="History"
      action={
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="rounded px-1.5 py-0.5 text-[11px] text-dim hover:bg-hover hover:text-ink"
        >
          {open ? 'Hide' : `Show ${history.entries.length} steps`}
        </button>
      }
    >
      {open && (
        <ol className="scroll-quiet max-h-44 overflow-y-auto px-1.5 pb-2" data-testid="history">
          {history.entries.map((entry, index) => (
            <li key={index}>
              <button
                type="button"
                aria-current={index === history.index ? 'step' : undefined}
                onClick={() => jumpToHistory(index)}
                className={cx(
                  'flex h-7 w-full items-center rounded px-2 text-left transition-colors',
                  index === history.index ? 'bg-accent/20 text-ink' : index > history.index ? 'text-faint hover:bg-hover' : 'text-dim hover:bg-hover',
                )}
              >
                {entry.label}
              </button>
            </li>
          ))}
        </ol>
      )}
    </PanelSection>
  );
}

export function RightPanel() {
  return (
    <aside aria-label="Layers and position" className="flex h-full w-64 shrink-0 flex-col divide-y divide-line border-l border-line bg-panel">
      <Layers />
      <Position />
      <HistoryList />
    </aside>
  );
}

