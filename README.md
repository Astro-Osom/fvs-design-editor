# FVS Design Editor

An open-source, local-first design editor for photo editing and YouTube thumbnails. It will run as a web app and as a desktop app.

> **Status: just started.** There is no application code yet. The goals and requirements are in [docs/PROJECT_BRIEF.md](docs/PROJECT_BRIEF.md).

## Goals

- Designs survive save, close and reopen, and export exactly as shown.
- Photo editing is nondestructive: originals are kept, and crops and adjustments stay editable.
- Text renders accurately, with the same line breaks in the editor and in exports.
- Thumbnail work is fast: small-size previews, feed mockups, quick variants and batch export.
- Everything works offline, and projects are files you control.

## Planned stack

React 19, TypeScript, Vite, Tailwind CSS and Zustand, with Fabric.js or Konva for the canvas and Electron or Tauri for the desktop shell. The canvas library and the desktop shell are still open choices; see the brief.

## Development

The project targets Node.js 22 and pnpm. Build and test commands will be documented here with the first application code.

### Cloud environment (Claude Code)

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

`DESKTOP_SHELL` accepts `auto`, `electron`, `tauri`, `both` or `none` and controls which desktop build dependencies the setup script installs.

**Secrets:** none. The app has no backend, so no keys are needed. Do not put credentials in environment variables; everyone who uses the environment can read them.

The setup script result is cached for about a week, so [scripts/session-start.sh](scripts/session-start.sh) also runs `pnpm install` at the start of each cloud session to match the checked-out branch. It does nothing on a local machine.

Cloud sessions run Linux, so they can check the web app and a Linux desktop build. macOS and Windows desktop builds need a local machine or CI.

## Contributing

Issues and pull requests are welcome. The project is early, so please open an issue before starting a large change.

## License

[MIT](LICENSE)
