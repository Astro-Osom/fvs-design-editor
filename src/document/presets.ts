/**
 * Page and export size presets. These are data, not limits: add or change entries
 * here as platforms change. Nothing else in the app assumes a particular size.
 */

export interface PagePreset {
  id: string;
  label: string;
  width: number;
  height: number;
}

export const PAGE_PRESETS: readonly PagePreset[] = [
  { id: 'thumbnail-720', label: 'YouTube thumbnail', width: 1280, height: 720 },
  { id: 'thumbnail-1080', label: 'Full HD thumbnail', width: 1920, height: 1080 },
  { id: 'thumbnail-4k', label: '4K thumbnail', width: 3840, height: 2160 },
  { id: 'square', label: 'Square post', width: 1080, height: 1080 },
];

/** Common output widths offered in the export dialog, alongside "same as page" and a custom size. */
export const EXPORT_WIDTHS: readonly number[] = [1280, 1920, 3840];

export function formatSize(width: number, height: number): string {
  return `${Math.round(width)} × ${Math.round(height)}`;
}
