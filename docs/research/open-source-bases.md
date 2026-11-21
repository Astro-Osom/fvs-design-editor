# Open-source bases: research and decision

Researched on 20 November 2026, before any application code was written, as the project brief requires.

## Decision

**Build from scratch on React 19, Vite and Fabric.js 7. Do not fork.**

No existing project is a suitable base. Each one fails at least one hard requirement: a licence that fits an MIT repo, an application-owned document model, original assets kept in a real asset store, or running with no server. Several MIT-licensed projects are good references, and their ideas are listed under [What we take from them](#what-we-take-from-them). No code was copied from any project.

## What a base had to offer

- React and TypeScript, with Fabric.js (preferred) or Konva as the canvas.
- A versioned document model owned by the application, with the canvas library used only to render it.
- Nondestructive image editing: originals kept, crop stored as parameters.
- A portable project file that includes the original assets.
- Export at exact pixel sizes, independent of zoom and screen density.
- No required backend.
- A permissive licence that allows commercial use and fits an MIT repo. GPL, AGPL, non-commercial terms and missing licences rule a project out as a fork.

## How this was checked

Repositories were read, not run. Stars, last push and licence were read through the GitHub API, and each LICENSE file was read directly rather than trusting the API's licence field. Source files were read to answer the questions below. Figures are as of 20 November 2026. Anything marked *unverified* could not be confirmed from the repository.

## The candidates named in the brief

| Project | Repository | Licence (from LICENSE file) | Stars | Last push | Stack | Verdict |
|---|---|---|---|---|---|---|
| Doory | [shaongitbd/doory](https://github.com/shaongitbd/doory) | Attribution Assurance License | 2,805 | 2026-11-19 | React 19, TypeScript, Vite 8, Fabric 7.2, Zustand, Yjs; Django backend | Ideas only |
| HyCanvas | [hyscaler/HyCanvas](https://github.com/hyscaler/HyCanvas) | AGPL-3.0, plus a paid commercial licence | 309 | 2026-11-19 | Next.js 16, React 19, its own Canvas 2D engine; Go and Postgres backend | Reject |
| OpenDesign | [clawnify/OpenDesign](https://github.com/clawnify/OpenDesign) | MIT | 135 | 2026-11-17 | Preact, Fabric 6, Vite 6; Cloudflare Workers backend | Reject as a base |
| Marketifyall editor | [Aadilhassan/Marketifyall-design-Editor](https://github.com/Aadilhassan/Marketifyall-design-Editor) | MIT | 10 | 2026-10-31 | React 17, Create React App, Fabric 4.5, scenify SDK, Supabase | Reject |

### Doory

Doory is the closest match architecturally and the most active (about 119,000 lines and 342 commits in six weeks).

- **Licence is the blocker.** The Attribution Assurance License allows commercial use and is not copyleft, but every redistribution must display the author's name and URL prominently each time the program starts. Forked code could not be relicensed as MIT, and the credit would be permanent.
- **Document model.** It has a versioned envelope (`schemaVersion`, pages), but the objects inside are Fabric's own `toObject()` output plus extra properties, so Fabric still defines the object schema. A migration runner exists with no migrations written yet.
- **Assets.** Originals are stored as blobs in IndexedDB, and a `.doory` zip holds the project and its assets. This is the right shape.
- **Crop and export.** Crop is nondestructive. Export renders from the document on a static canvas, so it is independent of zoom, with scale limited to 0.1–4×.
- **Backend.** Guest mode saves locally, but fonts, elements and templates come from the Django API. Whether the editor works with no backend at all is *unverified*.

### HyCanvas

AGPL-3.0 rules it out. It also uses its own rendering engine rather than Fabric or Konva, and needs a Go server and Postgres. Its document layer is a good reference: a fully application-owned schema with a real migration chain.

### OpenDesign

The name is ambiguous; `clawnify/OpenDesign` is the design editor. It is MIT, but small (about 5,900 lines, 28 commits). It saves raw `canvas.toJSON()` with no version, stores uploads on a server bucket, has no crop, and exports PNG at a fixed 2× from the live canvas.

### Marketifyall editor

A fork of an older editor on a legacy stack (React 17, Fabric 4). The engine is a third-party SDK whose original repository is GPL-3.0; a fork of it switched to MIT in August 2026, and whether that relicensing is valid is *unverified*. Uploads are stored as base64 inside the saved JSON.

## Other projects found

| Project | Licence | Stars | Last push | Stack | Document model | Verdict |
|---|---|---|---|---|---|---|
| [TheOrcDev/orcanva](https://github.com/TheOrcDev/orcanva) | MIT | 78 | 2026-11-05 | Next 16, React 19, react-konva, Zustand, Zod; Postgres | Application-owned, versioned, with migrations | Ideas only |
| [ashafizullah/klikdesign](https://github.com/ashafizullah/klikdesign) | MIT | 17 | 2026-11-08 | Tauri 2, React 19, Vite 8, react-konva | Application-owned, versioned | Ideas only |
| [ollisulopuisto/youthumber](https://github.com/ollisulopuisto/youthumber) | MIT | 0 | 2026-11-20 | React 19, Vite 8, Fabric 7.4; Python desktop shell | Application-owned; Fabric renders only | Ideas only |
| [Anu3ev/image-editor](https://github.com/Anu3ev/image-editor) | MIT | 20 | 2026-11-03 | TypeScript library on Fabric 7.2 | Fabric JSON | Ideas only |
| [salgum1114/react-design-editor](https://github.com/salgum1114/react-design-editor) | MIT | 1,710 | 2026-10-27 | React, Fabric 7.4, Ant Design | Fabric JSON | Ideas only |
| [mir-ashiq/canvix](https://github.com/mir-ashiq/canvix) | MIT | 234 | 2026-11-19 | Next 16, react-konva; Postgres | Application-owned, unversioned | Reject |
| [scaleflex/filerobot-image-editor](https://github.com/scaleflex/filerobot-image-editor) | MIT | 1,935 | 2026-06-16 | React 18 (JavaScript), react-konva | Application-owned, single image | Ideas only |
| [ikuaitu/vue-fabric-editor](https://github.com/ikuaitu/vue-fabric-editor) | MIT | 8,002 | 2026-07-21 | Vue 3, Fabric 5.3 | Fabric JSON | Ideas only |

Why none of them is a base:

- **orcanva** has the best document layer found (Zod schema, migration chain, crop stored as fractions, undo as change sets with transactions that collapse a drag into one step). It requires Postgres, object storage and hosted auth, uses Konva, and was created three weeks ago by one author.
- **klikdesign** is the closest to local-first desktop (a design file plus a media folder of originals). Its storage only works under Tauri, it uses Konva, and undo merges changes by time rather than by gesture.
- **youthumber** is the only React 19, Vite and Fabric 7 app with its own document model. The model is fixed to podcast-speaker layouts, images are stored as data URLs inside the project, and the desktop shell is Python.
- **Anu3ev/image-editor** has well-tested crop, snapping and export modules, but its history diffs Fabric's JSON, so Fabric is the source of truth.
- **react-design-editor** is mature, but saves Fabric JSON, bakes crops into new images, and exports with screen-density scaling on, so output depends on the display.
- **canvix** re-encodes images on crop and requires Postgres.
- **filerobot-image-editor** edits a single image, is JavaScript and has no tests.
- **vue-fabric-editor** is Vue on Fabric 5 and saves Fabric JSON.

### Looked at and set aside

- **No usable licence:** lidojs/canva-clone (no LICENSE file); kenvinlu/canva-editor (MIT with a no-resale clause); tldraw (needs a licence key in production); Polotno (proprietary key required).
- **Copyleft:** penpot (MPL-2.0, Clojure, server-based); several smaller GPL or AGPL editors, rejected on the API licence field without further reading.
- **Wrong stack or scope:** Graphite (Rust), excalidraw (whiteboard on its own renderer), miniPaint (vanilla JavaScript), bitmappery and yft-design (Vue), open-pencil (Vue with Tauri).
- **Stale or tied to a backend:** layerhub-io (dead since 2023), fabritor-web (Fabric 5, no tests, last commit 2024), and several "canva clone" tutorials that need auth and a database.

## Hugging Face

**Editors.** Nothing on Hugging Face is usable as a code base. Searches of Spaces for design, thumbnail, poster and image editors return mostly text-to-image demos. The few real editors are single-file toys or publish only a minified build. The one useful data point is [Chunte/Thumbnail-Crafter.mini](https://huggingface.co/spaces/Chunte/Thumbnail-Crafter.mini), a working thumbnail editor, which shows the product idea is sound.

**Cutout models for later.** Background removal is not part of the first slice, but the brief asks for local models with clear licences, so the survey was done now. Sizes are ONNX file sizes in MB (full precision / half precision / 8-bit), read from the model repositories. No model was run.

| Model | Licence | Commercial use | Size | Notes |
|---|---|---|---|---|
| briaai/RMBG-1.4 | Custom | **No** | 176 / 88 / 44 | Non-commercial unless licensed from the vendor |
| briaai/RMBG-2.0 | Custom, non-commercial | **No** | 1024 / 514 / 366 | Too large for a browser anyway |
| ZhengPeng7/BiRefNet_lite | MIT | Yes, with a caveat | 224 / 115 at 1024 px; 192 / 98.5 at 512 px | Best general quality under a permissive licence |
| ZhengPeng7/BiRefNet | MIT | Yes, with a caveat | 973 / 490 | Desktop only at this size |
| ISNet general-use | Unclear | Avoid | 176 / 88 / 44 | Weights have no explicit licence; ports disagree |
| U2Net / U2Netp | Apache-2.0 | Yes | 176 and 4.6 | Coarse edges |
| MODNet (Xenova/modnet) | Apache-2.0 | Yes | 25.9 / 13.0 / 6.6 | People only |
| SlimSAM (Xenova/slimsam-77-uniform) | Apache-2.0 | Yes | about 14 quantized, encoder plus decoder | Click-to-refine masks |

Two licence traps to remember:

- **Training data.** BiRefNet and ISNet were trained on DIS5K, whose terms prohibit commercial use of the dataset. BiRefNet's author states the weights may be used under the MIT licence. That is the author's position, not a legal ruling.
- **imgly background-removal-js** is AGPL-3.0. Do not depend on it.

Proposed choice when cutouts are built: **BiRefNet_lite at 512 px** (about 100 MB, one-time download) as the default, **MODNet** (7–13 MB) as the small fallback for people, and **SlimSAM** for click-to-refine. Model files should be self-hosted or bundled with the desktop app so the feature works offline. This still needs a hands-on test for speed and memory in the browser.

## What we take from them

Ideas only; everything is written fresh.

- **Versioned document envelope with a migration chain**, from HyCanvas and orcanva. We go further than Doory by defining our own object schema instead of saving Fabric's.
- **Original assets in a store, referenced by id, plus a zip project file**, from Doory and klikdesign. We use the SHA-256 of the bytes as the id, so an asset can be verified when a project is opened.
- **Crop as parameters mapped to Fabric's `cropX`/`cropY`**, as in youthumber and Anu3ev/image-editor.
- **Export rendered from the document on a separate static canvas**, with screen-density scaling off and no viewport transform, as in Doory and Anu3ev/image-editor.
- **One undo step per gesture**, as in orcanva and canvix.
- **For later:** snapping and guide handling in Anu3ev/image-editor and react-design-editor are worth reading before building ours.
