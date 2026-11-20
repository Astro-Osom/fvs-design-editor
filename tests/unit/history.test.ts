import { describe, expect, it } from 'vitest';
import { canRedo, canUndo, commit, createHistory, jumpTo, present, redo, undo } from '../../src/state/history';

describe('undo history', () => {
  it('records one step per commit and walks back and forward', () => {
    let h = createHistory('a', 'New design');
    h = commit(h, 'b', 'Add text');
    h = commit(h, 'c', 'Move layer');
    expect(h.entries.map((e) => e.label)).toEqual(['New design', 'Add text', 'Move layer']);
    expect(present(h)).toBe('c');

    h = undo(h);
    expect(present(h)).toBe('b');
    h = undo(h);
    expect(present(h)).toBe('a');
    expect(canUndo(h)).toBe(false);
    expect(undo(h)).toBe(h);

    h = redo(redo(h));
    expect(present(h)).toBe('c');
    expect(canRedo(h)).toBe(false);
  });

  it('ignores a commit that does not change the state', () => {
    const h = createHistory('a', 'New design');
    expect(commit(h, 'a', 'Nothing')).toBe(h);
  });

  it('drops undone steps when something new is committed', () => {
    let h = createHistory('a', 'New design');
    h = commit(h, 'b', 'One');
    h = commit(h, 'c', 'Two');
    h = undo(h);
    h = commit(h, 'd', 'Three');
    expect(h.entries.map((e) => e.state)).toEqual(['a', 'b', 'd']);
    expect(canRedo(h)).toBe(false);
  });

  it('keeps only the most recent steps once the limit is reached', () => {
    let h = createHistory(0, 'start');
    for (let i = 1; i <= 10; i++) h = commit(h, i, `step ${i}`, 4);
    expect(h.entries.map((e) => e.state)).toEqual([7, 8, 9, 10]);
    expect(present(h)).toBe(10);
  });

  it('jumps straight to any recorded step', () => {
    let h = createHistory('a', 'New design');
    h = commit(h, 'b', 'One');
    h = commit(h, 'c', 'Two');
    h = jumpTo(h, 0);
    expect(present(h)).toBe('a');
    expect(jumpTo(h, 9)).toBe(h);
    h = jumpTo(h, 2);
    expect(present(h)).toBe('c');
  });
});
