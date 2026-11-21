# Architecture

This describes how the editor is built as of the first working slice, why the main choices were made, and what is not built yet.

## Decisions

| Question | Choice | Main reason |
|---|---|---|
| Fork or build? | Build from scratch | No existing editor met the licence, document-model and no-server requirements. See [research/open-source-bases.md](research/open-source-bases.md). |
| Canvas library | Fabric.js 7 | On-canvas text editing and per-range text styles work out of the box; Konva has neither. |
| Desktop shell | Electron | The desktop app uses the same Chromium engine as the web version and the tests, so text layout and export are the same everywhere. |
| Source of truth | Our own versioned document | Fabric is used only to draw and to handle gestures. Nothing Fabric produces is ever saved. |
| Project file | A zip with the document, the original images and the fonts it may carry | One file that reopens anywhere, offline. |
| Upscaling photos | Real-ESRGAN "general x4 v3", run on the person's computer with ONNX Runtime Web | The only surveyed model that is clearly licensed (BSD-3-Clause), small (4.9 MB) and fast enough. See [research/upscaling.md](research/upscaling.md). |
| More fonts | Google Fonts downloaded on first use; installed fonts used where they are | Google's fonts are openly licensed but too many to ship; installed fonts are mostly licensed and may not be copied. See [research/fonts.md](research/fonts.md). |

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
  fonts/        Font files and families: reading font files, Google Fonts, installed fonts, the font store
  upscale/      Enlarging photos: the model and its download, tiling, the worker, a plain resize
  storage/      Browser database, recent projects, the project file format
  render/       Fabric: fonts, image decoding, node-to-object mapping, the canvas controller, export
  platform/     Opening and saving files (desktop, browser with file access, plain browser)
  ui/           React components
electron/       Desktop shell: window, app:// protocol, file dialogs
tests/unit/     Document, history, storage, font and project-file tests (no browser needed)
tests/e2e/      Whole-flow tests in Chromium and in the desktop app
tests/fixtures/ A document saved by each older format, to test upgrading
```

Dependencies point one way: `document` knows nothing about anything else; `fonts`, `render` and `storage` know the document; `state` ties them together; `ui` calls `state`.

## Separation of concerns

The brief asks for these to be strictly separate. This is where each one lives:

| Concern | Where | Notes |
|---|---|---|
| Document content | `history` in the store (`src/state/store.ts`) | Immutable. The only thing that is saved. |
| Undo history | The same `history` object (`src/state/history.ts`) | A list of document states and a current index. |
| Selection and current mode | `selection`, `cropNodeId`, `editingText` in the store | Never saved. |
| Viewport (zoom, pan) | `EditorCanvas` | Mirrored to the store only for the zoom readout. |
| Asset storage | `AssetStore` (`src/assets/assetStore.ts`) | Original bytes, keyed by their SHA-256. |
| Font storage | `FontStore` (`src/fonts/fontStore.ts`) | Font file bytes, keyed by their SHA-256, and the families collected on this machine. |
| Renderer instances | `EditorCanvas` (`src/render/EditorCanvas.ts`) | Fabric objects exist only here and in the exporter. |

## The document

Defined in `src/document/types.ts`. It is plain JSON: a schema version, pages, a list of the assets it refers to, and a table of the fonts it uses beyond the built-in ones. A page has a size, a background and an ordered list of nodes (bottom first). There are two node types so far, image and text.

**Geometry.** Units are page pixels. `(x, y)` is where a node's top-left corner sits on the page, and `rotation` is clockwise degrees about that corner. This does not depend on any library and stays well defined when a text box changes height.

**Images are nondestructive.** An image node holds an asset id, the frame it occupies on the page, and a `crop` rectangle in the original image's pixels. Cropping changes the frame and the crop rectangle; the stored image is never touched. The maths is in `src/document/geometry.ts`.

**Upscaling is nondestructive too.** An enlarged copy of a photo is a second asset with its own hash, which records what it was made from and how. The image node gains an `upscale` entry pointing at it; `assetId`, the crop and the frame still describe the original. Setting `upscale` back to null gives the original back exactly. See [Upscaling](#upscaling).

**Operations are pure.** Every function in `src/document/ops.ts` takes a document and returns a new one. That is what makes undo trivial and the whole layer testable without a browser.

**Versioning.** `schemaVersion` is 2. `parseDocument` in `src/document/schema.ts` runs any migrations in order, then validates the result. A document from a newer version is refused with a clear message instead of being half-loaded.

| Format | Change | Upgrade |
|---|---|---|
| 1 | First format. Built-in fonts only. | |
| 2 | Adds `fonts`, the table of fonts beyond the built-in ones. | The table starts empty, because format 1 could only use built-in fonts. |
| 3 | Adds `upscale` to photo layers, and `derivedFrom` to the asset record of an enlarged copy. | Every photo layer gets `upscale: null`. |

`tests/fixtures/document-v1.json` and `document-v2.json` are documents in the older formats; tests open them and check that nothing but the version and the new fields changes.

## Rendering and gestures

`src/render/nodeFactory.ts` turns a node into a Fabric object and reads a transformed object back into a node. The editing canvas and the exporter both use it, which is what keeps export identical to the screen.

`EditorCanvas` draws the current document and reconciles on each change: only nodes whose object identity changed are touched. During a drag, only Fabric changes and React does not re-render. When the gesture ends, the result is read back and committed once, so one drag is one undo step. A typing session commits once when it ends. Sliders and colour pickers update one undo step for the whole gesture.

**Crop mode** is explicit. The whole original is shown dimmed, with a frame over the part that is kept. Moving or resizing the frame never moves the photo. Enter applies, Escape cancels, and nothing changes in the document until it is applied.

**Working previews.** While editing, photos larger than 2048 pixels are drawn from a downscaled copy. Export always decodes the original.

## Upscaling

A photo that is stretched beyond its resolution looks soft. Upscale makes a larger copy with more detail, worked out on the person's own computer. The research, licences and measurements are in [research/upscaling.md](research/upscaling.md).

**What is stored.** The enlarged copy is a PNG in the asset store under its own hash. The document lists it like any asset, with `derivedFrom` saying which original it came from, by which method and by how much. The photo layer's `upscale` points at it. Because the layer's crop is always in the original's pixels, drawing from the copy is only a change of scale (`relativeTo` in `src/render/imageCache.ts`); crop, placement and undo need no special cases. A project file therefore reopens with the enlarged photo and never recomputes it. If the copy cannot be found, the original is drawn and a warning says so.

**How it is made** (`src/upscale`). The model runs in a Web Worker, on the graphics card through WebGPU where that works and on the processor through WebAssembly otherwise. The photo is cut into equal tiles with a margin of context, and only the middle of each result is kept, so every output pixel is written once and there are no seams (`tiles.ts`, pure and tested without a browser). The worker reports progress per tile; cancelling stops the worker. Nothing in the design changes until the result is accepted, which is one undo step.

**The model file** is not in the repository or the app. It is downloaded on first use from an address pinned to an exact revision, accepted only if its SHA-256 matches, and kept in browser storage for offline use (`model.ts`). If it cannot be downloaded or cannot run, a plain resize is offered and labelled as adding no new detail.

**Export** counts the enlarged copy: the "stretched and may look soft" warning is based on the pixels the photo is actually drawn from, and suggests Upscale when a photo has not been enlarged.

## Fonts

A font in a design comes from one of four places. The font menu groups them the same way.

| Source | Where the font data is | In a project file |
|---|---|---|
| Built in | Ships with the app: Inter, Montserrat, Poppins, Anton, Bebas Neue | Not needed |
| Google Fonts | Downloaded the first time a family is used, then kept in the font store | Always included (open licences) |
| Installed on the computer | Stays where it is; the design keeps the names of its faces | Only if the font's own permission allows it and the person opts in |
| A font file the person adds | Kept in the font store on that machine | Only if the font's own permission allows it and the person opts in |

The reasoning and the checks behind this are in [research/fonts.md](research/fonts.md).

**The design pins its fonts.** A family that is not built in has an entry in the document's `fonts` table: where it came from, its licence if known, whether it may be embedded, and every face it has. Each face lists its font files by SHA-256, or, for an installed font, the exact name the system knows the face by. So a design is drawn with the same font data wherever it is opened, even if that machine has a different version of the same family. Changing font is a pure operation (`setTextFont` in `src/document/ops.ts`) and one undo step; it moves the text to the nearest weight and style the new family really has, and drops table entries nothing uses any more.

**Loading.** `src/render/fonts.ts` is the only place fonts are handed to the browser. Before any text is measured, in the editor or in export, every face in use is fully loaded: built-in faces through the stylesheet, pinned files from the font store, installed faces by name with `local()`. A face that cannot be loaded is reported in the warning bar with the quickest fix (download it, or add its file), and export stops and asks. Nothing is substituted silently. When a font's data arrives or changes, text using it is laid out again.

**Only real styles.** The weight menu and the italic button list what the family actually has, so the browser never fakes a bold or an italic.

**Google Fonts.** The list of families (`src/fonts/google-catalogue.json`, names and styles only) ships with the app, so browsing and searching need no network. Picking a family fetches its stylesheet from `fonts.googleapis.com` and its files from `fonts.gstatic.com`, verifies each file is a font, and stores it. These are the only two hosts the app ever contacts, and only at that moment. Previews of fonts that are not downloaded yet are off unless the person turns them on, because they also come from Google.

**Installed fonts.** Chromium browsers and the desktop app can list installed fonts (`src/fonts/localFonts.ts`). Listing only starts when the person asks for it in the font menu: the first listing can take half a minute on a computer with many fonts, and the desktop app cannot quit while one is in progress. Elsewhere, and for fonts that are not installed, a `.ttf`, `.otf` or `.woff` file can be added. Whether such a font may travel inside a project is read from the font itself (`src/fonts/fontInfo.ts`); a font that forbids it, or does not say, is recorded by name only.

## Storage

There are three layers, from most convenient to most durable:

1. **Asset store and font store.** Original image bytes (and enlarged copies) and font file bytes in the browser's database, keyed by content hash. The downloaded enlarging model is kept there too.
2. **Autosave.** The document is written to the browser's database shortly after every change, with a visible status (saving, saved, failed). This backs the recent-designs screen and recovery after a crash. Each write replaces the record in a single transaction, so a failed write leaves the previous copy intact. If the same project is open in two tabs, the second one says so.
3. **Project file.** The copy the person controls, and the one that moves between machines.

### Project file format

A `.fvsdesign` file is a zip archive:

```text
manifest.json            Format name and version, app version, save time, and every font used with its source and licence
document.json            The document
assets/<sha256>.<ext>    Every original image, and every enlarged copy in use, byte for byte
fonts/<sha256>.<ext>     Font files the design is allowed to carry, byte for byte
```

On opening, each asset's and font file's bytes are hashed and compared with its id, so a damaged file is detected. Missing or damaged images are reported and shown as placeholders; a font whose file is missing or altered is reported as a missing font; the rest of the design still opens.

The archive format is version 2 (version 1 had no `fonts` folder). Font files are included only for fonts the design marks to be embedded: always for Google fonts, never for a font whose permission forbids it.

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

`electron/main.ts` serves the built web app from an `app://` address, which gives the page a stable, secure origin and its own storage. The page runs sandboxed with no Node access. Its content security policy allows its own files and, for downloads the person asks for, Google's two font hosts and Hugging Face (for the enlarging model); nothing else can be contacted. It also allows compiling WebAssembly, which the model's runtime needs. The preload script exposes three functions: open a project, save a project, save an export.

Electron grants every browser permission unless told otherwise. The app allows exactly one, listing installed fonts, and refuses the rest (camera, location, notifications and so on).

## What has been verified

On macOS (Apple silicon), 20 November 2026:

- 81 unit tests pass.
- 22 end-to-end tests pass: 18 in Chrome at 2x screen density and 4 in the Electron app.
- The main browser test checks that a 3840 × 2160 PNG export is byte-for-byte identical before saving, after zooming the editor, after reopening the project file, and after reopening from autosave.
- The desktop test saves to disk, quits, starts again with empty app storage, opens the file and gets an identical export. It also checks that a failed save leaves the existing file unchanged.
- Both check that the app makes no network requests beyond its own files.
- Fonts, in the browser: a Google font, a font file the person adds, and a font installed on the machine each give a byte-for-byte identical export after saving and reopening in a browser profile with empty storage. A design whose font is not available shows the missing-font warning and export refuses until told to continue. A font that forbids embedding is never written into a project file. Opening the list contacts nobody; a failed or cancelled download changes nothing.
- Fonts, in the desktop app: the security policy lets a Google font download and blocks every other host; only the installed-fonts permission is granted; a project with a downloaded font reopens from the file alone with Google unreachable.
- In those tests Google's two hosts are answered by the test with real, openly licensed font files. Against the real service, by hand in the running app: Lobster (5 files) and Noto Sans JP (124 files, 5.2 MB, 1.3 seconds).
- Upscaling, in the browser and in the desktop app, with a stand-in model that the real runtime runs in the real worker: upscale, compare, discard, keep (one undo step), undo and redo, save, and reopen with empty storage and no network give a byte-for-byte identical export, without recomputing. The enlarged copy was checked pixel by pixel against what the stand-in must produce. Turning it off gives an export identical to the one made before upscaling. Cancelling during the download and while the worker is starting changes nothing. With no connection, the plain resize is offered and stays labelled. A missing enlarged copy is reported and the original is used.
- Upscaling with the real model, run in the desktop app on this machine (Apple M1 Pro): a 1280 × 720 photo made 4 times larger took 5.4 to 5.8 seconds on the graphics card (7.3 seconds the first time, including the download) and about 150 seconds on the processor alone. Peak memory for the whole app was between 0.9 and 1.3 GB. Details are in [research/upscaling.md](research/upscaling.md).

On Linux, by the automatic checks (GitHub Actions on Ubuntu 26.04, x64), first run 21 November 2026:

- The same 81 unit tests and 22 end-to-end tests pass: 18 in Chromium and 4 in the Electron app, which runs on a virtual display. A whole run takes about two and a half minutes.
- Nothing in the app or the tests had to change for Linux.
- Both tests that use the fonts installed on the machine ran there; neither had to skip. Chromium and the desktop app each listed the machine's fonts and used one, and in the browser the design reopened with a byte-for-byte identical export.
- The byte-for-byte comparisons are between exports made in the same run. An export made on Linux was not compared with one made on macOS.
- These checks run again on every pull request and every push to `main`. See [Continuous integration](../README.md#continuous-integration).

Not verified:

- **Windows.** Nothing has been run there. That includes how installed fonts are listed and named.
- **Linux beyond the automatic checks.** They run on one kind of machine: Ubuntu 26.04, x64, a virtual display and no graphics card. Nobody has used the app by hand on Linux, so other distributions, a real screen and the fonts of a real Linux desktop are not covered.
- **The desktop app's own sandbox on Linux.** The automatic checks turn Electron's sandbox off, as the cloud environment does. Whether the app starts with it on was not tried.
- **The cloud environment.** The setup script has still not run on the cloud image.
- **Web version with no network at all.** It needs its files from the server on first load; there is no offline cache yet. The desktop app has everything on disk.
- **Screenshot baselines.** There are no stored reference images, because they differ by platform. The tests compare the app's own exports with each other instead.
- **Memory growth** over long sessions has not been measured.
- **Very large photos** have not been tested beyond 1600 × 1200 in automated tests.
- **Fonts in Firefox and Safari.** They cannot list installed fonts; the "add a font file" path exists for them but was only run in Chrome.
- **The browser's own permission question** for installed fonts. The tests grant the permission in advance, so the prompt itself was not clicked through.
- **Including an installed font in a project** is tested with a stand-in for the system's font list, not with a real installed font end to end.
- **Text in Chinese, Japanese or Korean** was not typed and exported.
- **Upscale quality on real photographs.** Only a synthetic test picture was looked at. Faces, hair, skin, foliage and screenshots with small text were not tried.
- **Upscaling with the real model on other graphics cards, on Windows or Linux, or in Firefox or Safari.** On Linux only the stand-in model has run, in the automatic checks; whether it ran on the graphics-card path or the processor path there was not recorded.
- **Cancelling in the middle of the tiles** of a long run is not covered by an automated test (the stand-in model is too fast); cancelling earlier in the same code path is.
- **Memory after many upscales in one sitting.** It did not return to its starting level between runs; whether that is a leak was not established.

## Not built yet

From the brief, in rough order of value:

- Photo adjustments (exposure, temperature, contrast and so on), with before/after.
- More for upscaling: several processor threads for computers without a usable graphics card (tried, and the runtime failed to start), a smaller fallback model once its licence is settled, a face model, and choosing which part of the photo the before and after view shows.
- Subject cutouts with editable masks. Model candidates and licences are in the research document.
- Thumbnail workflow: small-size preview, feed mockups, variants and batch export.
- Snapping and alignment guides.
- Shapes, groups and reusable style presets.
- Shadow controls. The document and renderer support shadows; there is no control for them yet.
- Image replacement that keeps the frame and crop.
- Multiple pages and PDF export.
- More for fonts: different fonts within one text box, removing downloaded fonts from the machine, and adding `.woff2` files.
- Light theme.
- An offline cache for the web version.
- Desktop installers, signing and automatic updates.
- Restoring the selection on undo.
