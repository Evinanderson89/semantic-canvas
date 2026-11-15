/**
 * Export returned rows as typed Excel or raw CSV, or a rendered view as PNG.
 * Files are produced client-side from the current query snapshot or DOM.
 */

/** RFC 4180: quote a field only when it needs it, double embedded quotes. */
function csvField(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: string[], rows: unknown[][]): string {
  const lines = [columns.map(csvField).join(",")];
  for (const row of rows) lines.push(row.map(csvField).join(","));
  // CRLF: the one line ending every spreadsheet app agrees on.
  return lines.join("\r\n") + "\r\n";
}

/** A safe, readable filename fragment from an arbitrary tile/dashboard title. */
export function slugForFilename(title: string): string {
  return title.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "export";
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the click has had a chance to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadCsv(filename: string, columns: string[], rows: unknown[][]) {
  downloadBlob(filename, new Blob([toCsv(columns, rows)], { type: "text/csv;charset=utf-8" }));
}

/** Load workbook code only when requested. Superseded results cannot download
 * after the asynchronous module load or compression completes. */
export async function downloadSpreadsheet(filename: string, columns: string[], rows: unknown[][], context: [string, unknown][], signal: AbortSignal) {
  const { toSpreadsheet } = await import("./spreadsheetExport.ts");
  if (signal.aborted) return;
  const blob = await toSpreadsheet(columns, rows, context);
  if (!signal.aborted) downloadBlob(filename, blob);
}

/** Snapshots `el` to a PNG and downloads it. Dynamically imports
 *  html-to-image so it's never in the bundle for anyone who never exports. */
export async function downloadPng(filename: string, el: HTMLElement, options: { hideControls?: boolean } = {}) {
  const { toBlob } = await import("html-to-image");
  // html-to-image has no timeout of its own -- if font/resource embedding
  // gets stuck on something (a slow or blocked network fetch, an
  // unresolvable stylesheet) it hangs forever with no error, which reads as
  // a frozen tab. skipFonts avoids the likeliest cause (this app has no
  // @font-face rules to begin with), and this race is the backstop for
  // whatever skipFonts doesn't cover.
  const blob = await Promise.race([
    toBlob(el, {
      backgroundColor: getComputedStyle(el).backgroundColor || "#ffffff",
      pixelRatio: 2, // crisp on a retina display, still a reasonable file size
      skipFonts: true,
      filter: (node: HTMLElement) => !(node instanceof Element &&
        (node.matches("[data-export-ignore]") || options.hideControls && node.matches("button") && !node.closest("th, .drill-crumbs"))),
      ...(options.hideControls ? {
        // A centered report's computed auto margin becomes a pixel offset in
        // the cloned SVG, but the image is only as wide as the report itself.
        style: { margin: "0" },
      } : {}),
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("rendering this took too long -- try a smaller tile, or the whole dashboard PNG instead")), 15000)),
  ]);
  if (!blob) throw new Error("could not render this as an image");
  downloadBlob(filename, blob);
}
