# FVS Design Editor

An open-source, local-first design editor for photo editing and YouTube thumbnails. It runs in the browser and as a desktop app, with no account and no server.

![The editor with a photo and a headline](docs/screenshots/editor.png)

> **Status: first working slice.** You can add photos and text, move, resize, rotate and crop them, undo and redo, save a portable project file, reopen it, and export PNG or JPG at exact pixel sizes. Much of the [project brief](docs/PROJECT_BRIEF.md) is still to come; see [what is not built yet](docs/architecture.md#not-built-yet).

## What works today

- **Photos:** upload, drop or paste. Originals are never altered; cropping only changes which part is shown, so it can always be changed back.
- **Text:** type directly on the page, with font, size, weight, colour, outline, alignment and spacing. Five fonts are bundled, so text works offline.
- **Layers:** show, hide, lock, rename and reorder, with exact position, size and rotation.
- **Undo:** one step per action, however long the drag or typing session, plus a history list.
- **Saving:** continuous autosave with a visible status, a recent-designs screen, and a project file (`.fvsdesign`) that contains the design and every original image.
- **Export:** PNG (with transparency) or JPG (with quality and a file-size limit) at any size up to 8192 pixels, identical whatever the zoom level or screen.

## Run it

You need Node.js 22 and pnpm.

```bash
pnpm install
```

Start the web version, then open the address it prints:

```bash
pnpm dev
```

Start the desktop app (the first run downloads Electron):

```bash
pnpm desktop
```

## Tests

Unit tests for the document model, undo history, storage and project files:

```bash
pnpm test
```

End-to-end tests in a real browser and in the desktop app. They run the whole flow (import, edit, crop, undo, save, reopen, export) and check that the exported image is byte-for-byte the same before saving and after reopening.

```bash
pnpm test:e2e
```

That uses Playwright's own Chromium, installed with `pnpm exec playwright install chromium`. To use an installed Google Chrome instead, set `PW_CHANNEL=chrome`. The desktop test opens an app window for a few seconds.

## How it is built

React 19, TypeScript, Vite, Tailwind CSS and Zustand, with Fabric.js 7 drawing the canvas and Electron as the desktop shell. The design is stored in the editor's own versioned document format; Fabric only renders it. The reasoning, the module layout and the file format are in [docs/architecture.md](docs/architecture.md), and the survey of existing editors that led to building from scratch is in [docs/research/open-source-bases.md](docs/research/open-source-bases.md).

## Cloud environment (Claude Code)

Cloud sessions use an environment configured at [claude.ai/code](https://claude.ai/code). Its settings are recorded here so anyone can reproduce them.

**Setup script:** the contents of [scripts/cloud-setup.sh](scripts/cloud-setup.sh). Keep the environment's copy and this file the same.

**Network access:** Limited, with "Allow package managers" checked, plus these allowed domains:

```text
cdn.playwright.dev
playwright.download.prss.microsoft.com
huggingface.co
*.huggingface.co
*.hf.co
```

**Environment variables:**

```text
DESKTOP_SHELL=auto
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
ELECTRON_DISABLE_SANDBOX=1
```

`DESKTOP_SHELL` accepts `auto`, `electron`, `tauri`, `both` or `none` and controls which desktop build dependencies the setup script installs. The project uses Electron, so `auto` or `electron` is right.

**Secrets:** none. The app has no backend, so no keys are needed. Do not put credentials in environment variables; everyone who uses the environment can read them.

The setup script result is cached for about a week, so [scripts/session-start.sh](scripts/session-start.sh) also runs `pnpm install` and fetches Electron at the start of each cloud session. It does nothing on a local machine.

Cloud sessions run Linux, so they can check the web app and a Linux desktop build. macOS and Windows desktop builds need a local machine or CI.

## Contributing

Issues and pull requests are welcome. The project is early, so please open an issue before starting a large change.

## License

[MIT](LICENSE)
