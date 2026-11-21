import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IdbAssetStore, sha256Hex } from '../../src/assets/assetStore';
import { createDocument } from '../../src/document/ops';
import { deleteProject, getProject, listProjects, putProject, type StoredProject } from '../../src/storage/projectsDb';

function project(name: string, updatedAt: string): StoredProject {
  const doc = createDocument({ name, width: 1280, height: 720 });
  return {
    id: doc.id,
    name,
    doc,
    updatedAt,
    savedToFileAt: null,
    hasUnsavedFileChanges: true,
    width: 1280,
    height: 720,
    thumbnail: null,
  };
}

describe('browser storage', () => {
  it('stores original image bytes under their content hash', async () => {
    const store = new IdbAssetStore();
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 250, 251, 252]);
    const id = await sha256Hex(bytes);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.has(id)).toBe(false);
    await store.put({ id, mime: 'image/png', bytes });
    expect(await store.has(id)).toBe(true);
    const back = await store.get(id);
    expect(back?.mime).toBe('image/png');
    expect(Array.from(back!.bytes)).toEqual(Array.from(bytes));
    expect(await store.get('f'.repeat(64))).toBeUndefined();
  });

  it('keeps autosaved projects, newest first, and replaces a record in place', async () => {
    const older = project('Older', '2026-01-01T10:00:00.000Z');
    const newer = project('Newer', '2026-01-02T10:00:00.000Z');
    await putProject(older);
    await putProject(newer);
    expect((await listProjects()).map((p) => p.name)).toEqual(['Newer', 'Older']);
    expect('doc' in (await listProjects())[0]!).toBe(false);

    await putProject({ ...older, name: 'Older, renamed', updatedAt: '2026-01-03T10:00:00.000Z' });
    expect((await listProjects()).map((p) => p.name)).toEqual(['Older, renamed', 'Newer']);
    expect((await getProject(older.id))?.doc.id).toBe(older.doc.id);

    await deleteProject(newer.id);
    expect((await listProjects()).map((p) => p.name)).toEqual(['Older, renamed']);
  });
});
