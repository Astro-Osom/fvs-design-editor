import { z } from 'zod';
import { SCHEMA_VERSION, type DesignDocument } from './types';

/**
 * Validation and migration for saved documents.
 *
 * Anything read from disk or browser storage goes through `parseDocument`
 * before the rest of the app sees it.
 */

const positive = z.number().positive();
const nonNegative = z.number().min(0);

const rectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: positive,
  height: positive,
});

const shadowSchema = z.object({
  color: z.string(),
  blur: nonNegative,
  offsetX: z.number(),
  offsetY: z.number(),
});

const outlineSchema = z.object({
  color: z.string(),
  width: nonNegative,
});

const nodeBase = {
  id: z.string().min(1),
  name: z.string(),
  x: z.number(),
  y: z.number(),
  rotation: z.number(),
  opacity: z.number().min(0).max(1),
  visible: z.boolean(),
  locked: z.boolean(),
  shadow: shadowSchema.nullable(),
};

const imageNodeSchema = z.object({
  ...nodeBase,
  type: z.literal('image'),
  assetId: z.string().min(1),
  width: positive,
  height: positive,
  crop: rectSchema,
  flipX: z.boolean(),
  flipY: z.boolean(),
});

const textNodeSchema = z.object({
  ...nodeBase,
  type: z.literal('text'),
  text: z.string(),
  width: positive,
  fontFamily: z.string().min(1),
  fontWeight: z.number().int().min(1).max(1000),
  fontStyle: z.enum(['normal', 'italic']),
  fontSize: positive,
  lineHeight: positive,
  letterSpacing: z.number(),
  align: z.enum(['left', 'center', 'right']),
  fill: z.string(),
  outline: outlineSchema.nullable(),
});

const nodeSchema = z.discriminatedUnion('type', [imageNodeSchema, textNodeSchema]);

const pageSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  width: positive,
  height: positive,
  background: z.string().nullable(),
  nodes: z.array(nodeSchema),
});

const assetSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{64}$/, 'asset id must be a SHA-256 hex digest'),
  kind: z.literal('image'),
  mime: z.string().min(1),
  bytes: nonNegative,
  width: positive,
  height: positive,
  name: z.string(),
});

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'must be a SHA-256 hex digest');

const fontFileSchema = z.object({
  id: sha256,
  bytes: nonNegative,
  format: z.enum(['woff2', 'woff', 'ttf', 'otf']),
  unicodeRange: z.string().optional(),
});

const fontFaceSchema = z.object({
  weight: z.number().int().min(1).max(1000),
  style: z.enum(['normal', 'italic']),
  files: z.array(z.number().int().min(0)),
  localName: z.string().min(1).optional(),
});

const documentFontSchema = z.object({
  family: z.string().min(1),
  source: z.enum(['google', 'installed', 'file']),
  license: z.string().optional(),
  embeddable: z.boolean(),
  embed: z.boolean(),
  files: z.array(fontFileSchema),
  faces: z.array(fontFaceSchema),
});

const documentSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().min(1),
  name: z.string(),
  createdAt: z.string(),
  pages: z.array(pageSchema).min(1),
  assets: z.record(z.string(), assetSchema),
  fonts: z.array(documentFontSchema),
});

export class DocumentError extends Error {
  constructor(
    message: string,
    readonly code: 'not-a-document' | 'newer-version' | 'invalid' | 'migration-failed',
  ) {
    super(message);
    this.name = 'DocumentError';
  }
}

/** A migration takes a document at version N and returns it at version N + 1. */
export type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

/**
 * Migrations keyed by the version they upgrade FROM. When the schema changes:
 * bump SCHEMA_VERSION, add `[oldVersion]: (doc) => ...` here, and add a fixture
 * of the old format to the tests (see tests/fixtures).
 */
export const MIGRATIONS: Record<number, Migration> = {
  // 1 -> 2: documents list the fonts they use beyond the built-in ones.
  // Version 1 could only use built-in fonts, so the list starts empty.
  1: (doc) => ({ ...doc, schemaVersion: 2, fonts: [] }),
};

/** Bring a raw document up to `targetVersion` by running each migration in order. */
export function migrate(
  raw: unknown,
  migrations: Record<number, Migration> = MIGRATIONS,
  targetVersion: number = SCHEMA_VERSION,
): { doc: Record<string, unknown>; migratedFrom: number | null } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new DocumentError('This is not a design document.', 'not-a-document');
  }
  let doc = raw as Record<string, unknown>;
  const startVersion = doc.schemaVersion;
  if (typeof startVersion !== 'number' || !Number.isInteger(startVersion) || startVersion < 1) {
    throw new DocumentError('This is not a design document (no schema version).', 'not-a-document');
  }
  if (startVersion > targetVersion) {
    throw new DocumentError(
      `This design was made with a newer version of the editor (format ${startVersion}; this version reads up to ${targetVersion}). Update the editor to open it.`,
      'newer-version',
    );
  }
  for (let v = startVersion; v < targetVersion; v++) {
    const step = migrations[v];
    if (!step) {
      throw new DocumentError(`No migration is available from format ${v} to ${v + 1}.`, 'migration-failed');
    }
    doc = step(structuredClone(doc));
    if (doc.schemaVersion !== v + 1) {
      throw new DocumentError(`The migration from format ${v} did not produce format ${v + 1}.`, 'migration-failed');
    }
  }
  return { doc, migratedFrom: startVersion === targetVersion ? null : startVersion };
}

/** Validate (and migrate if needed) anything that claims to be a document. */
export function parseDocument(raw: unknown): { doc: DesignDocument; migratedFrom: number | null } {
  const { doc: migrated, migratedFrom } = migrate(raw);
  const result = documentSchema.safeParse(migrated);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first ? `${first.path.join('.') || 'document'}: ${first.message}` : 'unknown problem';
    throw new DocumentError(`The design file is damaged or incomplete (${where}).`, 'invalid');
  }
  const doc = result.data as DesignDocument;

  const seen = new Set<string>();
  for (const page of doc.pages) {
    for (const node of page.nodes) {
      if (seen.has(node.id)) {
        throw new DocumentError(`The design file is damaged (two layers share the id ${node.id}).`, 'invalid');
      }
      seen.add(node.id);
      if (node.type === 'image' && !doc.assets[node.assetId]) {
        throw new DocumentError(
          `The design file is damaged (layer "${node.name}" refers to an image that is not listed).`,
          'invalid',
        );
      }
    }
  }
  for (const [key, asset] of Object.entries(doc.assets)) {
    if (key !== asset.id) {
      throw new DocumentError('The design file is damaged (an image is listed under the wrong id).', 'invalid');
    }
  }
  const families = new Set<string>();
  for (const font of doc.fonts) {
    if (families.has(font.family)) {
      throw new DocumentError(`The design file is damaged (the font ${font.family} is listed twice).`, 'invalid');
    }
    families.add(font.family);
    if (font.embed && !font.embeddable) {
      throw new DocumentError(`The design file is damaged (the font ${font.family} is marked to be included but may not be).`, 'invalid');
    }
    for (const face of font.faces) {
      if (face.files.some((index) => index >= font.files.length)) {
        throw new DocumentError(`The design file is damaged (the font ${font.family} refers to a file that is not listed).`, 'invalid');
      }
    }
  }
  return { doc, migratedFrom };
}
