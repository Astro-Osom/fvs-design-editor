import { MotionConfig } from 'motion/react';
import { useEffect } from 'react';
import { findNode } from '../document/ops';
import {
  addText,
  applyCrop,
  cancelCrop,
  copySelection,
  cutSelection,
  deleteSelection,
  duplicateSelection,
  hasClipboard,
  importImages,
  nudgeSelection,
  openProjectFromPicker,
  pasteClipboard,
  redo,
  reorderNode,
  saveProject,
  selectAll,
  startCrop,
  undo,
} from '../state/actions';
import { startAutosave } from '../state/autosave';
import { editorRef } from '../state/services';
import { selectDoc, setSelection, store, useEditor } from '../state/store';
import { Editor, Toast } from './Editor';
import { StartScreen } from './StartScreen';

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

/**
 * Keyboard shortcuts. They are context-aware: while typing in a field or in text
 * on the canvas, keys such as Delete and the arrows belong to the text, not to layers.
 */
function useShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const state = store.getState();
      if (state.screen !== 'editor') return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

      // File commands work wherever the focus is.
      if (mod && key === 's') {
        e.preventDefault();
        void saveProject(e.shiftKey);
        return;
      }
      if (mod && key === 'o') {
        e.preventDefault();
        void openProjectFromPicker();
        return;
      }
      if (state.dialog) return;
      if (mod && key === 'e') {
        e.preventDefault();
        if (!state.cropNodeId) store.setState({ dialog: 'export' });
        return;
      }
      if (isTyping(e.target)) return;

      const editor = editorRef.current;
      if (state.cropNodeId) {
        // In crop mode only the crop itself responds: Enter applies, Escape cancels.
        if (key === 'Enter') {
          e.preventDefault();
          applyCrop();
        } else if (key === 'Escape') {
          e.preventDefault();
          cancelCrop();
        } else if (mod && key === 'z') {
          e.preventDefault();
          cancelCrop();
        }
        return;
      }

      const doc = selectDoc(state);
      const single = doc && state.selection.length === 1 ? findNode(doc, state.selection[0]!)?.node : undefined;

      if (mod) {
        if (key === 'z') {
          e.preventDefault();
          if (e.shiftKey) redo();
          else undo();
        } else if (key === 'y') {
          e.preventDefault();
          redo();
        } else if (key === 'd' || key === 'j') {
          e.preventDefault();
          duplicateSelection();
        } else if (key === 'a') {
          e.preventDefault();
          selectAll();
        } else if (key === '0') {
          e.preventDefault();
          editor?.fitPage();
        } else if (key === '1') {
          e.preventDefault();
          editor?.actualSize();
        } else if (key === '=' || key === '+') {
          e.preventDefault();
          editor?.zoomBy(1.25);
        } else if (key === '-') {
          e.preventDefault();
          editor?.zoomBy(1 / 1.25);
        } else if ((key === ']' || key === '[') && single) {
          e.preventDefault();
          reorderNode(single.id, key === ']' ? (e.shiftKey ? 'front' : 'forward') : e.shiftKey ? 'back' : 'backward');
        }
        return;
      }

      const step = e.shiftKey ? 10 : 1;
      switch (key) {
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          deleteSelection();
          break;
        case 'Escape':
          setSelection([]);
          break;
        case 'Enter':
          if (single?.type === 'text') {
            e.preventDefault();
            editor?.editText(single.id);
          }
          break;
        case 'ArrowLeft':
          e.preventDefault();
          nudgeSelection(-step, 0);
          break;
        case 'ArrowRight':
          e.preventDefault();
          nudgeSelection(step, 0);
          break;
        case 'ArrowUp':
          e.preventDefault();
          nudgeSelection(0, -step);
          break;
        case 'ArrowDown':
          e.preventDefault();
          nudgeSelection(0, step);
          break;
        case 't':
          e.preventDefault();
          addText('heading', true);
          break;
        case 'c':
          if (single?.type === 'image') {
            e.preventDefault();
            startCrop(single.id);
          }
          break;
      }
    };

    // Copy and paste go through the browser's clipboard events so that pasting a
    // picture copied elsewhere brings it in as a photo, while layers copied here
    // stay fully editable.
    const editing = () => store.getState().screen === 'editor' && !store.getState().dialog && !store.getState().cropNodeId;
    const onCopy = (e: ClipboardEvent) => {
      if (!editing() || isTyping(e.target)) return;
      if (copySelection()) e.preventDefault();
    };
    const onCut = (e: ClipboardEvent) => {
      if (!editing() || isTyping(e.target)) return;
      if (store.getState().selection.length) {
        e.preventDefault();
        cutSelection();
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      if (!editing() || isTyping(e.target)) return;
      const files = Array.from(e.clipboardData?.files ?? []).filter((file) => file.type.startsWith('image/'));
      if (files.length) {
        e.preventDefault();
        void importImages(files);
      } else if (hasClipboard()) {
        e.preventDefault();
        pasteClipboard();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('copy', onCopy);
    window.addEventListener('cut', onCut);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('copy', onCopy);
      window.removeEventListener('cut', onCut);
      window.removeEventListener('paste', onPaste);
    };
  }, []);
}

export function App() {
  const screen = useEditor((s) => s.screen);
  useShortcuts();
  useEffect(() => startAutosave(), []);
  // Stop the browser from navigating away when a file is dropped outside the canvas.
  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  return (
    <MotionConfig reducedMotion="user">
      {screen === 'editor' ? <Editor /> : <StartScreen />}
      <Toast />
    </MotionConfig>
  );
}
