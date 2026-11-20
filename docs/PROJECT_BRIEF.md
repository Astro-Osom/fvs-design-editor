# Project brief

You are building a high-quality, local-first Canva-style design editor focused on photo editing and YouTube thumbnail creation. It must run as both a web app and a desktop app (Electron or Tauri).

## Core Philosophy
Build a dependable editor, not a convincing editor-shaped interface. Prioritize document round-trip fidelity, nondestructive editing, text rendering accuracy, predictable interaction, and correct export over matching Canva’s full feature set or asset library.

## Open-Source Research First (required)
Before writing any new code, thoroughly search GitHub and Hugging Face for existing open-source Canva-like or design-editor projects that could serve as a strong foundation.

Specifically look for:
- Repositories using Fabric.js, Konva, or similar canvas engines
- Projects that already have a working editor with text, images, layers, export, and project save/load
- Self-hostable or local-first design tools
- Anything labeled as Canva alternative, graphic design editor, thumbnail maker, or Fabric.js editor

For every promising candidate, evaluate and report:
- Tech stack and current maturity
- Document model and save/load fidelity
- License (must be compatible with commercial/personal use)
- How complete the editor is vs. just a demo
- Active maintenance and known issues
- How hard it would be to extend for nondestructive photo editing and YouTube thumbnail workflows

Strong candidates to check first (verify current state yourself):
- Doory (shaongitbd/doory)
- HyCanvas
- OpenDesign
- Marketifyall / other Fabric.js React editors
- Any newer or more complete projects you discover

Only start from scratch if no suitable base exists. Prefer forking or heavily building on the best existing editor and then applying the reliability, nondestructive, and thumbnail requirements below.

## Goal
Create a smooth, fast, intuitive personal design tool that feels familiar to Canva users but is reliable for real work (especially thumbnails and photo composition). Designs must survive save/close/reopen and export exactly as expected.

## Tech Direction
- Frontend: React 19 + TypeScript + Vite
- Canvas: Fabric.js (preferred) or Konva — choose after a small proof-of-concept that tests editable styled text, cropped images, groups, clipping, shadows, save/reopen, and full-resolution export
- Styling: Tailwind CSS + Framer Motion
- State: Zustand or equivalent
- Storage: Local-first with a proper storage adapter (IndexedDB + File System Access API where available). Never treat temporary object URLs as durable asset identity.
- Desktop: Electron or Tauri (shared codebase). Validate the core workflow early in both environments.
- Fonts: Google Fonts for discovery + local/bundled fonts for offline use
- Export: PNG, JPG, PDF (see detailed contracts below)

## Architecture Requirements
- Use an application-owned, versioned document model with stable object IDs.
- The canvas library is the rendering and interaction layer only — not the source of truth.
- Strictly separate:
  - Document content
  - Selection & active tool state
  - Viewport (zoom, pan)
  - Undo history
  - Asset storage
  - Renderer instances
- Versioned document schema with migration support.
- Portable project format that includes the document, original images, masks, asset references, and font information.

## Storage & Reliability (must-have)
- Explicit Save, Save As, Duplicate, Import, and Export Project.
- Autosave with visible states (saving / saved / failed / recovery available).
- Crash recovery and recent projects screen.
- Detection of the same project open in multiple tabs/windows.
- Missing-asset and missing-font recovery (with clear warnings, not silent substitution).
- Graceful handling of storage quota and disk-write failures (never destroy the last good save).
- Request persistent storage where possible, but always offer user-controlled project files as the reliable path.

## Interaction Semantics (define these clearly)
- Selection: shift-select, marquee, select-through, deselect, predictable group entry/exit
- Navigation: space-drag to pan, zoom to pointer, fit page, actual size
- Transforms: numeric position/size/rotation, aspect lock, modifier keys, flip, reset
- Snapping: page edges/center, other objects, equal spacing, temporary bypass
- Layers: rename, reorder, lock, hide, group, duplicate, select covered objects
- Crop: explicit crop mode (Enter applies, Escape cancels); moving crop frame ≠ moving image
- Text: clear distinction between selecting the text object and editing its contents
- Clipboard: internal copy/paste preserves editable objects; external image paste imports as image
- Cancellation: Escape consistently cancels current operation without losing other work
- Undo: one logical operation = one undo step (one drag, one slider gesture, one text-edit session). Must restore crops, masks, asset replacements, and page operations.

## Photo Editing (nondestructive from day one)
- Always preserve original images. Store crop and adjustments as editable parameters.
- Basic adjustments: exposure, temperature/tint, contrast, highlights/shadows, saturation/vibrance, sharpening.
- Before/after comparison and per-adjustment reset.
- Subject cutouts with editable masks (erase/restore brushes, softness, feathering, edge cleanup).
- Image replacement that preserves frame, crop intent, and effects.
- Reusable subject outline, shadow, and background blur styles.
- Any local AI (e.g. background removal) must specify model size, first-run requirements, hardware support, cancellation, and fallback.

## Thumbnail-Specific Workflow
- Small-size preview next to the working canvas.
- Light and dark feed mockups.
- Optional duration-badge and interface overlays (clearly labeled as previews).
- Fast A/B/C layout duplication and side-by-side variant comparison.
- Separate controls for subject treatment vs background treatment.
- Reusable headline, outline, gradient, and shadow presets.
- Batch export of selected variants with predictable filenames.
- Configurable platform presets. Support high-resolution YouTube thumbnails (up to 3840×2160) and make size budgets explicit. Do not hard-code outdated limits.

## Typography
- Independent text-box resizing vs font scaling.
- Line height, letter spacing, alignment, predictable wrapping.
- Fill, outline, shadow, background box, and padding.
- Clear handling of font weight/style availability.
- Fonts must finish loading before final layout and export.
- Warnings for missing fonts (no silent substitution).
- Identical line breaks after save, reopen, and export.
- Support for the languages you intend to use (test multiline, punctuation, emoji).

## Export Contracts
- PNG: optional alpha, explicit pixel dimensions.
- JPEG: explicit background flattening, quality control, file-size target.
- PDF: initially a clearly labeled rasterized multipage export.
- Explicit behavior for: hidden layers, objects outside page bounds, edge shadows/strokes, missing/loading assets, single vs selected vs all pages, low-resolution source warnings, color/orientation, cancellation, and memory failures.
- Output dimensions must be independent of editor zoom or monitor DPI.
- Handle cross-origin image tainting correctly (no silent SecurityError failures).

## Performance & Accessibility
- Avoid full-app React re-renders during pointer movement.
- Use lower-resolution working previews while keeping originals for export.
- Keep heavy image processing off the main interaction path.
- Lazy-render inactive pages.
- Test for memory growth on repeated import/replace/switch.
- Keyboard-operable toolbars and panels, visible focus, labeled controls, numeric alternatives to dragging, accessible layer list.
- Shortcut context awareness (Delete while editing text must not delete the object, etc.).
- Reduced-motion support.

## Development Approach
1. Start with one complete vertical slice and validate it in both browser and desktop shell:
   Import image → add styled text → transform & crop → undo/redo → save portable project → close → reopen → export at exact dimensions.
2. Build the document model and storage layer first.
3. Then expand the editor UI and tools.
4. Prefer rock-solid single-page editing, excellent text, fixable cutouts, and fast thumbnail variants over early multi-page complexity or large template libraries.
5. Add automated round-trip and visual regression tests for text, crops, groups, masks, shadows, transparency, missing assets, and failed saves.
6. Test the core workflow with networking disabled.

## UI Requirements
The interface must be elegant, smooth, easy to use and very beginner-friendly, while producing professional results. Take what is simplest about Canva and what is simplest about Photoshop, and blend the two. This section replaces the earlier "Canva-like information architecture" wording wherever the two conflict.

- **From Canva, the ease of adding and styling:** a labelled left rail whose panels add things with one click (photos, text presets, later shapes). There are no tool modes to learn: clicking selects and dragging moves. A contextual toolbar above the canvas shows only the controls that apply to the current selection. Presets and plain-language labels do most of the work.
- **From Photoshop, the control and precision:** a Layers panel with show, hide, lock and reorder; exact numeric position, size and rotation; nondestructive crop and adjustments; a History list; and the shortcuts people already know, such as Cmd/Ctrl+Z undo, Cmd/Ctrl+J duplicate, T text, C crop, Space-drag to pan and arrow keys to nudge.
- **Layout:** the left rail and its panel, the contextual toolbar across the top, the canvas in the centre, and Layers and Position on the right. Use a calm dark neutral theme by default so the artwork stands out, with a light theme available.
- **Beginner-friendly:** every control has a visible label or a tooltip that shows its shortcut. An empty canvas shows clear first steps, such as "Add a photo" and "Add text". Defaults are sensible, advanced options sit behind "More", undo is always visible, and wording avoids jargon (say "Outline", not "Stroke").
- **Professional outcomes:** exact export sizes, originals always preserved, precise alignment and numeric control, and accurate text.
- **Thumbnail work stays close:** size presets, the small-size preview and variants are one click away.
- **Original visual design:** borrow the familiar structure and behaviour, not the look. Use our own icons, colours and names. Do not copy Adobe's or Canva's icons, artwork, logos, product names or exact styling.
- **Polish:** clean typography, subtle motion, reduced-motion support, and no placeholder controls for unsupported features.

Begin by proposing the architecture and the vertical-slice plan (after the open-source research), then implement. Ask only blocking questions.
