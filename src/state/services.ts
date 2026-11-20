import { IdbAssetStore, type AssetStore } from '../assets/assetStore';
import type { EditorCanvas } from '../render/EditorCanvas';
import { ImageCache } from '../render/imageCache';

/** Long-lived objects that are not state: where assets are stored, and the live canvas. */
export const assets: AssetStore = new IdbAssetStore();
export const images = new ImageCache(assets);

/** The mounted canvas controller, if the editor is on screen. */
export const editorRef: { current: EditorCanvas | null } = { current: null };

export const APP_VERSION = '0.1.0';
