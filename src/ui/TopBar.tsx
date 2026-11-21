import { CircleCheck, Download, FolderOpen, House, LoaderCircle, Redo2, Save, TriangleAlert, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { platformKind } from '../platform/files';
import { closeProject, openProjectFromPicker, redo, renameProject, saveProject, undo } from '../state/actions';
import { selectCanRedo, selectCanUndo, selectDoc, selectHasUnsavedFileChanges, store, useEditor } from '../state/store';
import { Button, Divider, IconButton, shortcut } from './controls';

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden className="shrink-0">
      <rect x="2" y="5" width="20" height="14" rx="3.5" fill="var(--color-accent)" />
      <path d="M6.5 15.5 10 11l2.6 3 2-2.2 3 3.7z" fill="var(--color-on-accent)" opacity="0.9" />
      <circle cx="16.3" cy="9.2" r="1.4" fill="var(--color-on-accent)" opacity="0.9" />
    </svg>
  );
}

/** Says, in plain words, whether the work is safe and where. */
function SaveStatus() {
  const autosave = useEditor((s) => s.autosave);
  const file = useEditor((s) => s.file);
  const unsaved = useEditor(selectHasUnsavedFileChanges);
  const where = platformKind() === 'desktop' ? 'on this computer' : 'in this browser';

  if (autosave.kind === 'saving') {
    return (
      <span role="status" className="flex items-center gap-1.5 text-dim" data-testid="save-status" data-state="saving">
        <LoaderCircle size={14} className="animate-spin" /> Saving…
      </span>
    );
  }
  if (autosave.kind === 'failed') {
    return (
      <span role="alert" title={autosave.message} className="flex items-center gap-1.5 text-warn" data-testid="save-status" data-state="failed">
        <TriangleAlert size={14} /> Autosave is off. Save a project file.
      </span>
    );
  }
  if (autosave.kind === 'idle') return <span data-testid="save-status" data-state="idle" />;
  const text = file
    ? unsaved
      ? `Autosaved ${where}. ${file.name} has unsaved changes.`
      : `All changes saved to ${file.name}`
    : `Autosaved ${where}. Not saved to a file yet.`;
  return (
    <span role="status" className="flex min-w-0 items-center gap-1.5 text-dim" data-testid="save-status" data-state={unsaved ? 'autosaved' : 'saved'}>
      <CircleCheck size={14} className={unsaved ? 'shrink-0 text-dim' : 'shrink-0 text-ok'} />
      <span className="truncate">{text}</span>
    </span>
  );
}

function ProjectName() {
  const name = useEditor((s) => selectDoc(s)?.name ?? '');
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  return (
    <input
      aria-label="Design name"
      title="Design name"
      value={draft}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onBlur={() => renameProject(draft)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setDraft(name);
          e.currentTarget.blur();
        }
      }}
      className="h-8 w-52 min-w-0 rounded-md bg-transparent px-2 text-[13px] font-medium text-ink outline-none hover:bg-raised focus:bg-raised"
    />
  );
}

export function TopBar() {
  const canUndo = useEditor(selectCanUndo);
  const canRedo = useEditor(selectCanRedo);
  const busy = useEditor((s) => s.busy);
  const cropping = useEditor((s) => s.cropNodeId !== null);

  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line bg-panel px-2">
      <IconButton label="Back to your designs" onClick={() => void closeProject()}>
        <House size={17} />
      </IconButton>
      <Logo />
      <ProjectName />
      <Divider />
      <IconButton label="Open a project file" keys={shortcut('O', { mod: true })} onClick={() => void openProjectFromPicker()}>
        <FolderOpen size={17} />
      </IconButton>
      <Button
        variant="ghost"
        icon={<Save size={16} />}
        keys={shortcut('S', { mod: true })}
        disabled={!!busy}
        onClick={() => void saveProject(false)}
        data-testid="save-button"
      >
        Save
      </Button>
      <Button variant="ghost" keys={shortcut('S', { mod: true, shift: true })} disabled={!!busy} onClick={() => void saveProject(true)}>
        Save as…
      </Button>
      <Divider />
      <IconButton label="Undo" keys={shortcut('Z', { mod: true })} disabled={!canUndo} onClick={undo} data-testid="undo-button">
        <Undo2 size={17} />
      </IconButton>
      <IconButton label="Redo" keys={shortcut('Z', { mod: true, shift: true })} disabled={!canRedo} onClick={redo} data-testid="redo-button">
        <Redo2 size={17} />
      </IconButton>

      <div className="mx-3 min-w-0 flex-1 text-right text-[12px]">
        <SaveStatus />
      </div>

      <Button
        variant="primary"
        icon={<Download size={16} />}
        keys={shortcut('E', { mod: true })}
        disabled={cropping}
        onClick={() => store.setState({ dialog: 'export' })}
        data-testid="export-button"
      >
        Export
      </Button>
    </header>
  );
}
