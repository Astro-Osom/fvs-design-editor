# Architecture

This describes how the editor is built as of the first working slice, why the main choices were made, and what is not built yet.

## Decisions

| Question | Choice | Main reason |
|---|---|---|
| Fork or build? | Build from scratch | No existing editor met the licence, document-model and no-server requirements. See [research/open-source-bases.md](research/open-source-bases.md). |
| Canvas library | Fabric.js 7 | On-canvas text editing and per-range text styles work out of the box; Konva has neither. |
| Desktop shell | Electron | The desktop app uses the same Chromium engine as the web version and the tests, so text layout and export are the same everywhere. |
| Source of truth | Our own versioned document | Fabric is used only to draw and to handle gestures. Nothing Fabric produces is ever saved. |
| Project file | A zip with the document and the original images | One file that reopens anywhere, offline. |

### Canvas library: proof of concept

Both libraries were run in headless Chrome at 2x screen density, building the same scene: a cropped photo with a circular clip and a shadow, outlined wrapping text, and a rotated group. The script and raw output are in [research/canvas-poc](research/canvas-poc).

| Check | Fabric.js 7.4.0 | Konva 10.10.0 |
|---|---|---|
| Cropped image (crop stored as numbers) | Yes | Yes |
| Clipping | Any object, any shape | Containers only |
| Shadows, groups | Yes | Yes |
| Different styles within one text box | Yes | No |
| Typing on the canvas | Built in; real keystrokes worked | Not provided; needs a custom text field overlay |
| Export 1280 × 720 scene at 3840 × 2160 on a 2x screen | Exact size | Exact size |
| Same line breaks after reload | Yes | Yes |
| Export unaffected by editor zoom | **No** | **No** |
| Library's own save format reproduces the scene | Yes, but embeds each image as text inside the JSON | No: images and clip shapes are dropped |

Two results shaped the design beyond the choice of Fabric:

- **Neither library's export ignores the editor's zoom.** So export never uses the editing canvas. It draws the document on a separate canvas (see [Export](#export)).
- **Neither library's save format is suitable.** Fabric's embeds images as base64 text, which would make project files enormous; Konva's loses them. So the document and the assets are stored by the application.

### Desktop shell: Electron, not Tauri

The editor's core promise is that text and exports are identical after save, reopen and export. Electron ships one browser engine on every platform, the same one the web version and the tests use. Tauri uses each operating system's own web view (WebKit on macOS and Linux, Chromium on Windows), so line breaks and canvas output could differ between platforms and from the web version.

The cost is size: Electron apps are roughly 100 MB or more, where Tauri apps are a few megabytes. Tauri was assessed on paper only; it was not prototyped, because the Rust toolchain is not installed on the machine this was built on. The desktop-specific code is about 150 lines behind a three-function interface (`DesktopBridge` in `src/platform/files.ts`), so changing shell later would not touch the editor.

## Layout of the code

```text
src/
  document/     The document: types, validation and migration, pure operations, crop maths
  state/        Undo history, the store, actions, autosave
  assets/       Where original image bytes are kept
  storage/      Browser database, recent projects, the project file format
  render/       Fabric: fonts, image decoding, node-to-object mapping, the canvas controller, export
  platform/     Opening and saving files (desktop, browser with file access, plain browser)
  ui/           React components
electron/       Desktop shell: window, app:// protocol, file dialogs
tests/unit/     Document, history, storage and project-file tests (no browser needed)
tests/e2e/      Whole-flow tests in Chromium and in the desktop app
```

Dependencies point one way: `document` knows nothing about anything else; `render` and `storage` know the document; `state` ties them together; `ui` calls `state`.

## Separation of concerns

The brief asks for these to be strictly separate. This is where each one lives:

| Concern | Where | Notes |
|---|---|---|
| Document content | `history` in the store (`src/state/store.ts`) | Immutable. The only thing that is saved. |
| Undo history | The same `history` object (`src/state/history.ts`) | A list of document states and a current index. |
| Selection and current mode | `selection`, `cropNodeId`, `editingText` in the store | Never saved. |
| Viewport (zoom, pan) | `EditorCanvas` | Mirrored to the store only for the zoom readout. |
| Asset storage | `AssetStore` (`src/assets/assetStore.ts`) | Original bytes, keyed by their SHA-256. |
| Renderer instances | `EditorCanvas` (`src/render/EditorCanvas.ts`) | Fabric objects exist only here and in the exporter. |

## The document

Defined in `src/document/types.ts`. It is plain JSON: a schema version, pages, and a list of the assets it refers to. A page has a size, a background and an ordered list of nodes (bottom first). There are two node types so far, image and text.

**Geometry.** Units are page pixels. `(x, y)` is where a node's top-left corner sits on the page, and `rotation` is clockwise degrees about that corner. This does not depend on any library and stays well defined when a text box changes height.

**Images are nondestructive.** An image node holds an asset id, the frame it occupies on the page, and a `crop` rectangle in the original image's pixels. Cropping changes the frame and the crop rectangle; the stored image is never touched. The maths is in `src/document/geometry.ts`.

**Operations are pure.** Every function in `src/document/ops.ts` takes a document and returns a new one. That is what makes undo trivial and the whole layer testable without a browser.

**Versioning.** `schemaVersion` is 1. `parseDocument` in `src/document/schema.ts` runs any migrations in order, then validates the result. A document from a newer version is refused with a clear message instead of being half-loaded.

## Rendering and gestures

`src/render/nodeFactory.ts` turns a node into a Fabric object and reads a transformed object back into a node. The editing canvas and the exporter both use it, which is what keeps export identical to the screen.

`EditorCanvas` draws the current document and reconciles on each change: only nodes whose object identity changed are touched. During a drag, only Fabric changes and React does not re-render. When the gesture ends, the result is read back and committed once, so one drag is one undo step. A typing session commits once when it ends. Sliders and colour pickers update one undo step for the whole gesture.

**Crop mode** is explicit. The whole original is shown dimmed, with a frame over the part that is kept. Moving or resizing the frame never moves the photo. Enter applies, Escape cancels, and nothing changes in the document until it is applied.

**Working previews.** While editing, photos larger than 2048 pixels are drawn from a downscaled copy. Export always decodes the original.

## Fonts

Five families are bundled (Inter, Montserrat, Poppins, Anton, Bebas Neue), so text works with no network. Only weights and italics that exist as real font files are offered. Before any text is measured, in the editor or in export, the faces it needs are loaded and Fabric's glyph-width cache is cleared. A font that is not available is reported in a warning bar and in the font menu, and export stops and asks rather than substituting it silently.

## Storage

There are three layers, from most convenient to most durable:

1. **Asset store.** Original image bytes in the browser's database, keyed by content hash.
2. **Autosave.** The document is written to the browser's database shortly after every change, with a visible status (saving, saved, failed). This backs the recent-designs screen and recovery after a crash. Each write replaces the record in a single transaction, so a failed write leaves the previous copy intact. If the same project is open in two tabs, the second one says so.
3. **Project file.** The copy the person controls, and the one that moves between machines.

### Project file format

A `.fvsdesign` file is a zip archive:

```text
manifest.json            Format name and version, app version, save time, fonts used
document.json            The document
assets/<sha256>.<ext>    Every original image, byte for byte
```

On opening, each asset's bytes are hashed and compared with its id, so a damaged file is detected. Missing or damaged images are reported and shown as placeholders; the rest of the design still opens.

Saving never damages an existing file. The desktop app writes a temporary file and renames it; browsers with file access swap the file only when the write completes; other browsers download a new copy.

## Export

`src/render/exportPage.ts` states the contract in full. In short:

- The output is exactly the requested pixel size. It is drawn on its own canvas straight from the document, so editor zoom, window size and screen density cannot affect it.
- Originals are used, not previews.
- Hidden layers are left out. Anything outside the page is cut off at the page edge.
- PNG can keep transparency. JPG is flattened onto the page colour, or a chosen colour if the page is transparent.
- JPG can be held under a file-size limit by lowering quality, to a floor of 0.3. If that is not enough, the smallest result is returned with a warning.
- Missing fonts or images stop the export unless the person chooses to continue.
- A photo stretched beyond 150% of its resolution produces a warning.
- Sizes above 8192 pixels on the longest side are refused, and an encoding failure is reported as a memory problem.

## Desktop shell

`electron/main.ts` serves the built web app from an `app://` address, which gives the page a stable, secure origin and its own storage. The page runs sandboxed with no Node access and a content security policy that only allows its own files. The preload script exposes three functions: open a project, save a project, save an export.

## What has been verified

On macOS (Apple silicon), 20 November 2026:

- 37 unit tests pass.
- 10 end-to-end tests pass: 9 in Chrome at 2x screen density and 1 in the Electron app.
- The main browser test checks that a 3840 × 2160 PNG export is byte-for-byte identical before saving, after zooming the editor, after reopening the project file, and after reopening from autosave.
- The desktop test saves to disk, quits, starts again with empty app storage, opens the file and gets an identical export. It also checks that a failed save leaves the existing file unchanged.
- Both check that the app makes no network requests beyond its own files.

Not verified:

- **Linux and Windows.** Nothing has been run on either.
- **The cloud environment.** The setup script has still not run on the cloud image.
- **Web version with no network at all.** It needs its files from the server on first load; there is no offline cache yet. The desktop app has everything on disk.
- **Screenshot baselines.** There are no stored reference images, because they differ by platform and only macOS was available. The tests compare the app's own exports with each other instead.
- **Memory growth** over long sessions has not been measured.
- **Very large photos** have not been tested beyond 1600 × 1200 in automated tests.

## Not built yet

From the brief, in rough order of value:

- Photo adjustments (exposure, temperature, contrast and so on), with before/after.
- Subject cutouts with editable masks. Model candidates and licences are in the research document.
- Thumbnail workflow: small-size preview, feed mockups, variants and batch export.
- Snapping and alignment guides.
- Shapes, groups and reusable style presets.
- Shadow controls. The document and renderer support shadows; there is no control for them yet.
- Image replacement that keeps the frame and crop.
- Multiple pages and PDF export.
- Google Fonts browsing, and embedding fonts in project files.
- Light theme.
- An offline cache for the web version.
- Desktop installers, signing and automatic updates.
- Restoring the selection on undo.
