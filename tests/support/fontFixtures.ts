import { unzlibSync } from 'fflate';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Font files for tests. They come from the @fontsource packages in node_modules,
 * which are openly licensed (OFL-1.1), so nothing proprietary is ever committed.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function fontsourceFile(pkg: string, file: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(ROOT, 'node_modules', '@fontsource', pkg, 'files', file)));
}

export const pacificoWoff = () => fontsourceFile('pacifico', 'pacifico-latin-400-normal.woff');
export const pacificoWoff2 = () => fontsourceFile('pacifico', 'pacifico-latin-400-normal.woff2');
export const lobsterWoff = () => fontsourceFile('lobster', 'lobster-latin-400-normal.woff');
export const lobsterWoff2 = () => fontsourceFile('lobster', 'lobster-latin-400-normal.woff2');

/**
 * Turn a WOFF file into a plain TrueType/OpenType file, optionally changing the
 * embedding permission (`fsType` in the OS/2 table). This is how the tests get a
 * font that forbids embedding without shipping one.
 */
export function woffToSfnt(woff: Uint8Array, options: { fsType?: number } = {}): Uint8Array {
  const view = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
  const flavor = view.getUint32(4);
  const count = view.getUint16(12);
  const tables: { tag: string; data: Uint8Array; checksum: number }[] = [];
  for (let i = 0; i < count; i++) {
    const at = 44 + i * 20;
    const tag = String.fromCharCode(...woff.subarray(at, at + 4));
    const offset = view.getUint32(at + 4);
    const compressedLength = view.getUint32(at + 8);
    const length = view.getUint32(at + 12);
    const raw = woff.subarray(offset, offset + compressedLength);
    const data = (compressedLength === length ? raw : unzlibSync(raw)).slice();
    if (tag === 'OS/2' && options.fsType !== undefined) new DataView(data.buffer).setUint16(8, options.fsType);
    tables.push({ tag, data, checksum: view.getUint32(at + 16) });
  }
  tables.sort((a, b) => (a.tag < b.tag ? -1 : 1));
  const headerLength = 12 + tables.length * 16;
  const total = headerLength + tables.reduce((sum, table) => sum + ((table.data.length + 3) & ~3), 0);
  const out = new Uint8Array(total);
  const outView = new DataView(out.buffer);
  const entrySelector = Math.floor(Math.log2(tables.length));
  outView.setUint32(0, flavor);
  outView.setUint16(4, tables.length);
  outView.setUint16(6, 2 ** entrySelector * 16);
  outView.setUint16(8, entrySelector);
  outView.setUint16(10, tables.length * 16 - 2 ** entrySelector * 16);
  let offset = headerLength;
  tables.forEach((table, i) => {
    const at = 12 + i * 16;
    for (let c = 0; c < 4; c++) out[at + c] = table.tag.charCodeAt(c);
    outView.setUint32(at + 4, table.checksum);
    outView.setUint32(at + 8, offset);
    outView.setUint32(at + 12, table.data.length);
    out.set(table.data, offset);
    offset += (table.data.length + 3) & ~3;
  });
  return out;
}
