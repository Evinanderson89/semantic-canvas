/**
 * The canvas has a fixed authored size the user picks. Everything downstream --
 * snapping, alignment, and later the responsive inference -- is far more
 * tractable when the design has one known geometry rather than reflowing while
 * you are still placing things.
 */
export interface CanvasPreset {
  id: string; label: string; group: string;
  width: number; height: number; hint?: string;
}

export const PRESETS: CanvasPreset[] = [
  { id: "desktop",   label: "Desktop",        group: "Screen", width: 1440, height: 900,  hint: "1440 × 900" },
  { id: "desktop-hd",label: "Desktop HD",     group: "Screen", width: 1920, height: 1080, hint: "1920 × 1080" },
  { id: "laptop",    label: "Laptop",         group: "Screen", width: 1280, height: 800,  hint: "1280 × 800" },
  { id: "tablet",    label: "Tablet",         group: "Screen", width: 1024, height: 768,  hint: "1024 × 768" },
  { id: "phone",     label: "Phone",          group: "Screen", width: 390,  height: 844,  hint: "390 × 844" },
  { id: "widescreen",label: "Widescreen 16:9",group: "Screen", width: 1280, height: 720,  hint: "1280 × 720" },
  // Print sizes are in CSS pixels at 96dpi, so a Letter canvas is literally the
  // page it will print onto.
  { id: "letter",    label: "Letter",         group: "Print",  width: 816,  height: 1056, hint: '8.5" × 11" portrait' },
  { id: "letter-l",  label: "Letter landscape", group: "Print", width: 1056, height: 816, hint: '11" × 8.5"' },
  { id: "a4",        label: "A4",             group: "Print",  width: 794,  height: 1123, hint: "210 × 297 mm" },
  { id: "a4-l",      label: "A4 landscape",   group: "Print",  width: 1123, height: 794,  hint: "297 × 210 mm" },
];

export interface CanvasSpec {
  preset: string;
  width: number;
  height: number;
  snap: boolean;
  grid: number;
  locked: boolean;
  background?: string;
}

export const DEFAULT_CANVAS: CanvasSpec = {
  preset: "desktop", width: 1440, height: 900, snap: true, grid: 8, locked: false,
};

export function presetById(id: string) {
  return PRESETS.find((p) => p.id === id) ?? null;
}
