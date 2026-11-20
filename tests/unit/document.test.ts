import { describe, expect, it } from 'vitest';
import {
  addAsset,
  addNode,
  createDocument,
  duplicateNodes,
  findNode,
  firstPage,
  fontsUsed,
  makeImageNode,
  makeTextNode,
  moveNodeToIndex,
  nodeLabel,
  pruneUnusedAssets,
  resizePage,
  removeNodes,
  shiftNode,
  updateNode,
  updatePage,
} from '../../src/document/ops';
import { DocumentError, migrate, parseDocument } from '../../src/document/schema';
import type { AssetInfo, DesignDocument } from '../../src/document/types';

const asset: AssetInfo = {
  id: 'a'.repeat(64),
  kind: 'image',
  mime: 'image/png',
  bytes: 1234,
  width: 2000,
  height: 1000,
  name: 'beach photo.png',
};

function sampleDoc(): DesignDocument {
  let doc = createDocument({ name: 'Sample', width: 1280, height: 720 });
  doc = addAsset(doc, asset);
  doc = addNode(doc, makeImageNode(asset, firstPage(doc)));
  doc = addNode(doc, makeTextNode(firstPage(doc), 'headline'));
  return doc;
}

describe('document operations', () => {
  it('creates a one-page document with stable ids', () => {
    const doc = createDocument({ width: 1280, height: 720 });
    expect(doc.schemaVersion).toBe(1);
    expect(doc.name).toBe('Untitled design');
    expect(doc.pages).toHaveLength(1);
    expect(firstPage(doc)).toMatchObject({ width: 1280, height: 720, background: '#ffffff', nodes: [] });
  });

  it('fits a new image inside the page, centred, showing the whole image', () => {
    const page = { width: 1280, height: 720 };
    const node = makeImageNode(asset, page);
    expect(node.crop).toEqual({ x: 0, y: 0, width: 2000, height: 1000 });
    expect(node.width / node.height).toBeCloseTo(2);
    expect(node.width).toBeLessThanOrEqual(1280 * 0.9 + 1e-9);
    expect(node.x + node.width / 2).toBeCloseTo(640);
    expect(node.y + node.height / 2).toBeCloseTo(360);
    expect(node.name).toBe('beach photo');
  });

  it('never mutates its input', () => {
    const doc = sampleDoc();
    const frozen = structuredClone(doc);
    const [image, text] = firstPage(doc).nodes;
    updateNode(doc, image!.id, { x: 99, opacity: 0.5 });
    removeNodes(doc, [text!.id]);
    shiftNode(doc, image!.id, 'front');
    duplicateNodes(doc, [image!.id]);
    updatePage(doc, firstPage(doc).id, { width: 1920, height: 1080 });
    expect(doc).toEqual(frozen);
  });

  it('returns the same document when a change changes nothing', () => {
    const doc = sampleDoc();
    const image = firstPage(doc).nodes[0]!;
    expect(updateNode(doc, image.id, { x: image.x })).toBe(doc);
    expect(removeNodes(doc, ['missing'])).toBe(doc);
    expect(shiftNode(doc, image.id, 'back')).toBe(doc);
  });

  it('updates, reorders, duplicates and removes layers', () => {
    let doc = sampleDoc();
    const [image, text] = firstPage(doc).nodes;
    doc = updateNode(doc, image!.id, { x: 10, y: 20, rotation: 30 });
    expect(findNode(doc, image!.id)!.node).toMatchObject({ x: 10, y: 20, rotation: 30 });

    doc = shiftNode(doc, image!.id, 'front');
    expect(firstPage(doc).nodes.map((n) => n.id)).toEqual([text!.id, image!.id]);
    doc = moveNodeToIndex(doc, image!.id, 0);
    expect(firstPage(doc).nodes.map((n) => n.id)).toEqual([image!.id, text!.id]);

    const dup = duplicateNodes(doc, [image!.id]);
    expect(dup.ids).toHaveLength(1);
    const ids = firstPage(dup.doc).nodes.map((n) => n.id);
    expect(ids).toEqual([image!.id, dup.ids[0], text!.id]);
    const copy = findNode(dup.doc, dup.ids[0]!)!.node;
    expect(copy).toMatchObject({ type: 'image', x: 34, y: 44, rotation: 30 });

    doc = removeNodes(dup.doc, [image!.id, dup.ids[0]!]);
    expect(firstPage(doc).nodes.map((n) => n.id)).toEqual([text!.id]);
    // The asset record stays in the document so undo can bring the image back...
    expect(Object.keys(doc.assets)).toEqual([asset.id]);
    // ...and is dropped only when writing a project file.
    expect(Object.keys(pruneUnusedAssets(doc).assets)).toEqual([]);
  });

  it('scales the design with the page when the proportions stay the same', () => {
    const doc = sampleDoc();
    const page = firstPage(doc);
    const [image, text] = page.nodes;
    const bigger = firstPage(resizePage(doc, page.id, 3840, 2160));
    expect(bigger).toMatchObject({ width: 3840, height: 2160 });
    const [bigImage, bigText] = bigger.nodes;
    expect(bigImage).toMatchObject({ x: image!.x * 3, width: (image as { width: number }).width * 3 });
    expect((bigImage as { crop: unknown }).crop).toEqual((image as { crop: unknown }).crop);
    expect(bigText).toMatchObject({ fontSize: (text as { fontSize: number }).fontSize * 3 });

    // A different shape only changes the page; layers stay where they are.
    const square = firstPage(resizePage(doc, page.id, 1080, 1080));
    expect(square.nodes).toEqual(page.nodes);
  });

  it('lists the fonts in use and labels layers in plain language', () => {
    const doc = sampleDoc();
    expect(fontsUsed(doc)).toEqual([{ family: 'Anton', weight: 400, style: 'normal' }]);
    const [image, text] = firstPage(doc).nodes;
    expect(nodeLabel(image!)).toBe('beach photo');
    expect(nodeLabel(text!)).toBe('BIG TITLE');
    expect(nodeLabel({ ...text!, name: 'Title' })).toBe('Title');
  });
});

describe('document validation and migration', () => {
  it('accepts a document it produced, after a JSON round trip', () => {
    const doc = sampleDoc();
    const { doc: parsed, migratedFrom } = parseDocument(JSON.parse(JSON.stringify(doc)));
    expect(parsed).toEqual(doc);
    expect(migratedFrom).toBeNull();
  });

  it('rejects things that are not documents', () => {
    for (const bad of [null, 42, 'text', [], {}, { schemaVersion: 'one' }]) {
      expect(() => parseDocument(bad)).toThrow(DocumentError);
    }
  });

  it('refuses a document from a newer version with a clear message', () => {
    const doc = { ...sampleDoc(), schemaVersion: 99 };
    expect(() => parseDocument(doc)).toThrow(/newer version/);
  });

  it('rejects damaged documents instead of loading them partially', () => {
    const doc = JSON.parse(JSON.stringify(sampleDoc()));
    doc.pages[0].nodes[0].width = -5;
    expect(() => parseDocument(doc)).toThrow(/damaged/);

    const dupIds = JSON.parse(JSON.stringify(sampleDoc()));
    dupIds.pages[0].nodes[1].id = dupIds.pages[0].nodes[0].id;
    expect(() => parseDocument(dupIds)).toThrow(/share the id/);

    const orphan = JSON.parse(JSON.stringify(sampleDoc()));
    orphan.assets = {};
    expect(() => parseDocument(orphan)).toThrow(/not listed/);
  });

  it('runs migrations in order, one version at a time', () => {
    const migrations = {
      1: (d: Record<string, unknown>) => ({ ...d, schemaVersion: 2, title: d.name, name: undefined }),
      2: (d: Record<string, unknown>) => ({ ...d, schemaVersion: 3, tags: [] }),
    };
    const { doc, migratedFrom } = migrate({ schemaVersion: 1, name: 'Old' }, migrations, 3);
    expect(doc).toMatchObject({ schemaVersion: 3, title: 'Old', tags: [] });
    expect(migratedFrom).toBe(1);
  });

  it('fails loudly when a migration is missing or wrong', () => {
    expect(() => migrate({ schemaVersion: 1 }, {}, 2)).toThrow(/No migration/);
    expect(() => migrate({ schemaVersion: 1 }, { 1: (d) => d }, 2)).toThrow(/did not produce/);
  });
});
