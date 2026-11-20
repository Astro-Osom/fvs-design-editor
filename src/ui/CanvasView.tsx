import { ImagePlus, Type } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { EditorCanvas } from '../render/EditorCanvas';
import { addPhotosFromPicker, addText, commitNodes, importImages, removeNodesById, startCrop } from '../state/actions';
import { editorRef, images } from '../state/services';
import { selectDoc, selectPage, setSelection, store, useEditor } from '../state/store';
import { Button } from './controls';

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, i) => Object.is(item, b[i]));
}

/** The working canvas. React only mounts it; drawing and gestures belong to EditorCanvas. */
export function CanvasView() {
  const hostRef = useRef<HTMLDivElement>(null);
  const doc = useEditor(selectDoc);
  const selection = useEditor((s) => s.selection);
  const isEmpty = useEditor((s) => (selectPage(s)?.nodes.length ?? 0) === 0);
  const [dropping, setDropping] = useState(false);

  useEffect(() => {
    const editor = new EditorCanvas(hostRef.current!, images, {
      onCommitNodes: commitNodes,
      onRemoveNodes: (ids, label) => {
        removeNodesById(ids, label);
        setSelection(store.getState().selection.filter((id) => !ids.includes(id)));
      },
      onSelectionChange: setSelection,
      onEditingTextChange: (editingText) => {
        if (store.getState().editingText !== editingText) store.setState({ editingText });
      },
      onZoomChange: (zoom) => {
        if (Math.abs(store.getState().zoom - zoom) > 1e-4) store.setState({ zoom });
      },
      onRequestCrop: (id) => startCrop(id),
      onCropEnded: () => {
        if (store.getState().cropNodeId !== null) store.setState({ cropNodeId: null });
      },
      onProblems: ({ missingFonts, missingAssets, lostEnlargements }) => {
        const { warnings } = store.getState();
        const fontKeys = (list: typeof missingFonts) => list.map((f) => `${f.family}|${f.weight}|${f.style}`);
        if (
          sameList(warnings.missingAssets, missingAssets) &&
          sameList(fontKeys(warnings.missingFonts), fontKeys(missingFonts)) &&
          sameList(warnings.lostEnlargements, lostEnlargements)
        ) {
          return;
        }
        store.setState({ warnings: { ...warnings, missingAssets, missingFonts, lostEnlargements } });
      },
    });
    editorRef.current = editor;
    return () => {
      if (editorRef.current === editor) editorRef.current = null;
      editor.dispose();
    };
  }, []);

  useEffect(() => {
    if (doc) void editorRef.current?.setDocument(doc);
  }, [doc]);

  useEffect(() => {
    editorRef.current?.select(selection);
  }, [selection]);

  return (
    <div
      className="relative h-full w-full bg-app"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropping(false);
        void importImages(Array.from(e.dataTransfer.files));
      }}
    >
      <div ref={hostRef} className="canvas-host" data-testid="canvas-host" />

      {isEmpty && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="pointer-events-auto flex flex-col items-center gap-3 rounded-xl bg-panel/95 px-8 py-6 text-center shadow-pop">
            <p className="text-[15px] font-semibold text-ink">Start your design</p>
            <p className="max-w-64 text-dim">Add a photo or some text. You can also drop a photo anywhere on this page.</p>
            <div className="flex gap-2">
              <Button variant="primary" icon={<ImagePlus size={16} />} onClick={() => void addPhotosFromPicker()}>
                Add a photo
              </Button>
              <Button icon={<Type size={16} />} onClick={() => addText('heading', true)}>
                Add text
              </Button>
            </div>
          </div>
        </div>
      )}

      {dropping && (
        <div className="pointer-events-none absolute inset-3 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-accent/10">
          <p className="text-[15px] font-semibold text-ink">Drop to add your photo</p>
        </div>
      )}
    </div>
  );
}
