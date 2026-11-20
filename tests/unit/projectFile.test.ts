import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { MemoryAssetStore, sha256Hex } from '../../src/assets/assetStore';
import { addAsset, addNode, createDocument, firstPage, makeImageNode, makeTextNode, removeNodes } from '../../src/document/ops';
import type { AssetInfo, DesignDocument } from '../../src/document/types';
import { packProject, ProjectFileError, projectFileName, unpackProject } from '../../src/storage/projectFile';

async function fixture() {
  const store = new MemoryAssetStore();
  const bytes = new Uint8Array(5000).map((_, i) => (i * 31) % 251);
  const id = await sha256Hex(bytes);
  await store.put({ id, mime: 'image/png', bytes });
  const asset: AssetInfo = { id, kind: 'image', mime: 'image/png', bytes: bytes.length, width: 800, height: 600, name: 'photo.png' };

  let doc: DesignDocument = createDocument({ name: 'My thumbnail', width: 1280, height: 720 });
  doc = addAsset(doc, asset);
  doc = addNode(doc, makeImageNode(asset, firstPage(doc)));
  doc = addNode(doc, { ...makeTextNode(firstPage(doc), 'headline'), text: 'Line one\nLine two 🎉' });
  return { store, bytes, asset, doc };
}

describe('portable project file', () => {
  it('round-trips the document and the original image bytes exactly', async () => {
    const { store, bytes, asset, doc } = await fixture();
    const packed = await packProject({ doc, getAsset: (id) => store.get(id), appVersion: '0.1.0' });
    expect(packed.missingAssets).toEqual([]);

    const opened = await unpackProject(packed.bytes);
    expect(opened.doc).toEqual(doc);
    expect(opened.missingAssets).toEqual([]);
    expect(opened.corruptAssets).toEqual([]);
    expect(opened.assets).toHaveLength(1);
    expect(opened.assets[0]!.id).toBe(asset.id);
    expect(Array.from(opened.assets[0]!.bytes)).toEqual(Array.from(bytes));
    expect(opened.manifest).toMatchObject({
      format: 'fvs-design-project',
      formatVersion: 1,
      documentName: 'My thumbnail',
      fonts: [{ family: 'Anton', weight: 400, style: 'normal' }],
    });
  });

  it('survives a second save after reopening without any drift', async () => {
    const { store, doc } = await fixture();
    const first = await unpackProject((await packProject({ doc, getAsset: (id) => store.get(id), appVersion: '0.1.0' })).bytes);
    const store2 = new MemoryAssetStore();
    for (const a of first.assets) await store2.put(a);
    const second = await unpackProject(
      (await packProject({ doc: first.doc, getAsset: (id) => store2.get(id), appVersion: '0.1.0' })).bytes,
    );
    expect(second.doc).toEqual(doc);
  });

  it('leaves out images that no layer uses any more', async () => {
    const { store, doc } = await fixture();
    const withoutImage = removeNodes(doc, [firstPage(doc).nodes[0]!.id]);
    const opened = await unpackProject(
      (await packProject({ doc: withoutImage, getAsset: (id) => store.get(id), appVersion: '0.1.0' })).bytes,
    );
    expect(opened.assets).toEqual([]);
    expect(opened.doc.assets).toEqual({});
  });

  it('reports a missing image instead of failing or hiding it', async () => {
    const { doc, asset } = await fixture();
    const packed = await packProject({ doc, getAsset: async () => undefined, appVersion: '0.1.0' });
    expect(packed.missingAssets).toEqual([asset.id]);
    const opened = await unpackProject(packed.bytes);
    expect(opened.missingAssets).toEqual([asset.id]);
    expect(opened.doc).toEqual(doc);
  });

  it('detects image bytes that do not match their id', async () => {
    const { doc, asset } = await fixture();
    const tampered = new Uint8Array(5000).fill(7);
    const packed = await packProject({
      doc,
      getAsset: async (id) => ({ id, mime: 'image/png', bytes: tampered }),
      appVersion: '0.1.0',
    });
    const opened = await unpackProject(packed.bytes);
    expect(opened.corruptAssets).toEqual([asset.id]);
    expect(opened.assets).toEqual([]);
  });

  it('rejects files that are not projects with a plain message', async () => {
    await expect(unpackProject(strToU8('definitely not a zip'))).rejects.toThrow(ProjectFileError);
    const otherZip = zipSync({ 'hello.txt': strToU8('hi') });
    await expect(unpackProject(otherZip)).rejects.toThrow(/not a design project/);
    const wrongFormat = zipSync({
      'manifest.json': strToU8(JSON.stringify({ format: 'something-else', formatVersion: 1 })),
      'document.json': strToU8('{}'),
    });
    await expect(unpackProject(wrongFormat)).rejects.toThrow(/not a design project/);
  });

  it('refuses projects from a newer version rather than guessing', async () => {
    const { doc } = await fixture();
    const newerFile = zipSync({
      'manifest.json': strToU8(JSON.stringify({ format: 'fvs-design-project', formatVersion: 2 })),
      'document.json': strToU8(JSON.stringify(doc)),
    });
    await expect(unpackProject(newerFile)).rejects.toThrow(/newer version/);
    const newerDoc = zipSync({
      'manifest.json': strToU8(JSON.stringify({ format: 'fvs-design-project', formatVersion: 1 })),
      'document.json': strToU8(JSON.stringify({ ...doc, schemaVersion: 5 })),
    });
    await expect(unpackProject(newerDoc)).rejects.toThrow(/newer version/);
  });

  it('builds safe, predictable file names', () => {
    expect(projectFileName('My thumbnail')).toBe('My thumbnail.fvsdesign');
    expect(projectFileName('a/b:c*d?')).toBe('a b c d.fvsdesign');
    expect(projectFileName('   ')).toBe('Untitled design.fvsdesign');
  });
});
