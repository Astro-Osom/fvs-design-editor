/**
 * Undo history as a list of immutable states.
 *
 * One call to `commit` is one undo step. Callers are responsible for committing
 * once per logical operation (one drag, one slider gesture, one text-edit session).
 */

export interface HistoryEntry<T> {
  state: T;
  /** Plain-language description shown in the History panel, e.g. "Move layer". */
  label: string;
}

export interface History<T> {
  entries: HistoryEntry<T>[];
  /** Index of the current state in `entries`. */
  index: number;
}

export const HISTORY_LIMIT = 100;

export function createHistory<T>(state: T, label: string): History<T> {
  return { entries: [{ state, label }], index: 0 };
}

export function present<T>(history: History<T>): T {
  return history.entries[history.index]!.state;
}

export function canUndo<T>(history: History<T>): boolean {
  return history.index > 0;
}

export function canRedo<T>(history: History<T>): boolean {
  return history.index < history.entries.length - 1;
}

/** Record a new state. Anything that had been undone is discarded. */
export function commit<T>(history: History<T>, state: T, label: string, limit = HISTORY_LIMIT): History<T> {
  if (state === present(history)) return history;
  const entries = history.entries.slice(0, history.index + 1);
  entries.push({ state, label });
  const overflow = Math.max(0, entries.length - limit);
  return { entries: overflow ? entries.slice(overflow) : entries, index: entries.length - 1 - overflow };
}

export function undo<T>(history: History<T>): History<T> {
  return canUndo(history) ? { ...history, index: history.index - 1 } : history;
}

export function redo<T>(history: History<T>): History<T> {
  return canRedo(history) ? { ...history, index: history.index + 1 } : history;
}

export function jumpTo<T>(history: History<T>, index: number): History<T> {
  if (index < 0 || index >= history.entries.length || index === history.index) return history;
  return { ...history, index };
}
