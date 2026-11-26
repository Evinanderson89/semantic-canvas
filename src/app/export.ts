/**
 * Export returned rows as typed Excel or raw CSV, or a rendered view as PNG / Vector SVG.
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
  a.href = url;
  a.download = filename;
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
export async function downloadSpreadsheet(
  filename: string,
  columns: string[],
  rows: unknown[][],
  context: [string, unknown][],
  signal: AbortSignal,
) {
  const { toSpreadsheet } = await import("./spreadsheetExport.ts");
  if (signal.aborted) return;
  const blob = await toSpreadsheet(columns, rows, context);
  if (!signal.aborted) downloadBlob(filename, blob);
}

/** Snapshots `el` to a PNG and downloads it. Dynamically imports
 *  html-to-image so it's never in the bundle for anyone who never exports. */
export async function downloadPng(filename: string, el: HTMLElement, options: { hideControls?: boolean } = {}) {
  const { toBlob } = await import("html-to-image");
  const blob = await Promise.race([
    toBlob(el, {
      backgroundColor: getComputedStyle(el).backgroundColor || "#ffffff",
      pixelRatio: 2,
      skipFonts: true,
      filter: (node: HTMLElement) =>
        !(
          node instanceof Element &&
          (node.matches("[data-export-ignore]") ||
            (options.hideControls && node.matches("button") && !node.closest("th, .drill-crumbs")))
        ),
      ...(options.hideControls ? { style: { margin: "0" } } : {}),
    }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("rendering this took too long -- try a smaller tile, or the whole dashboard PNG instead")),
        15000,
      ),
    ),
  ]);
  if (!blob) throw new Error("could not render this as an image");
  downloadBlob(filename, blob);
}

export const DEFAULT_SVG_TOKENS: Record<string, string> = {
  "--ground": "#f6f8fc",
  "--panel": "#ffffff",
  "--surface": "#ffffff",
  "--surface-2": "#edf2f9",
  "--line": "#e5e7eb",
  "--line-2": "#c1cde0",
  "--rule-masthead": "#090d16",
  "--ink": "#111827",
  "--ink-2": "#4b5563",
  "--ink-3": "#6b7280",
  "--accent": "#1d4ed8",
  "--accent-soft": "#dbeafe",
  "--on-accent": "#ffffff",
  "--accent-edge": "#1e40af",
  "--pos": "#059669",
  "--pos-soft": "#ecfdf5",
  "--pos-border": "#a7f3d0",
  "--neg": "#e11d48",
  "--neg-soft": "#ffe4e6",
  "--neg-border": "#fecdd3",
  "--warn": "#d97706",
  "--warn-soft": "#fef3c7",
};

const SVG_TOKEN_KEYS = Object.keys(DEFAULT_SVG_TOKENS);

export function collectComputedSvgTokens(
  el?: unknown,
  tokenMap?: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = { ...DEFAULT_SVG_TOKENS };
  if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
    try {
      if (typeof document !== "undefined" && document.documentElement) {
        const rootStyle = window.getComputedStyle(document.documentElement);
        for (const key of SVG_TOKEN_KEYS) {
          const val = rootStyle.getPropertyValue(key).trim();
          if (val) merged[key] = val;
        }
      }
      if (el && typeof Element !== "undefined" && el instanceof Element) {
        const elStyle = window.getComputedStyle(el);
        for (const key of SVG_TOKEN_KEYS) {
          const val = elStyle.getPropertyValue(key).trim();
          if (val) merged[key] = val;
        }
      }
    } catch {
      // Ignore style resolution errors in non-DOM test environments.
    }
  }
  if (tokenMap) {
    for (const [k, v] of Object.entries(tokenMap)) {
      merged[k.startsWith("--") ? k : `--${k}`] = v;
    }
  }
  return merged;
}

export function resolveSvgMarkup(rawSvg: string, tokenMap?: Record<string, string>): string {
  const mergedTokens = collectComputedSvgTokens(undefined, tokenMap);
  let normalized = rawSvg.replace(/^<svg\b([^>]*)>/i, (_full: string, attrs: string) => {
    let nextAttrs = attrs;
    if (!/\bxmlns\s*=/.test(nextAttrs)) {
      nextAttrs += ' xmlns="http://www.w3.org/2000/svg"';
    }
    if (!/\bxmlns:xlink\s*=/.test(nextAttrs)) {
      nextAttrs += ' xmlns:xlink="http://www.w3.org/1999/xlink"';
    }
    return `<svg${nextAttrs}>`;
  });

  // Resolve nested var(--token, fallback) up to 2 passes so fallback variables resolve cleanly.
  for (let pass = 0; pass < 2; pass++) {
    normalized = normalized.replace(
      /var\(\s*(--[a-zA-Z0-9_-]+)\s*(?:,\s*([^()]+?)\s*)?\)/g,
      (match: string, name: string, fallback?: string) => {
        if (name in mergedTokens) return mergedTokens[name];
        if (fallback) return fallback.trim();
        return match;
      },
    );
  }
  return normalized;
}

function decodeSvgDataUrl(dataUrl: string): string {
  const trimmed = dataUrl.trim();
  if (trimmed.startsWith("<svg")) return trimmed;
  const commaIdx = trimmed.indexOf(",");
  if (commaIdx < 0) throw new Error("invalid SVG data URL");
  const header = trimmed.slice(0, commaIdx);
  const payload = trimmed.slice(commaIdx + 1);
  if (/;base64/i.test(header)) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  }
  return decodeURIComponent(payload);
}

/**
 * Extracts and normalizes an `<svg>` subtree with resolved CSS design tokens
 * and XML namespaces so it imports cleanly into Figma, Keynote, or Illustrator.
 */
export function serializeSvgElement(
  root: {
    tagName?: string;
    outerHTML?: string;
    querySelector?: (sel: string) => any;
    querySelectorAll?: (sel: string) => ArrayLike<any>;
  },
  tokenMap?: Record<string, string>,
): string {
  const tokens = collectComputedSvgTokens(root, tokenMap);
  if (root?.tagName?.toLowerCase() === "svg" && typeof root.outerHTML === "string") {
    return resolveSvgMarkup(root.outerHTML, tokens);
  }

  // If multiple chart SVGs exist inside a mock container without DOM layout, pick the largest chart SVG rather than a tiny icon.
  let svgEl: any = null;
  if (typeof root?.querySelectorAll === "function") {
    const all = Array.from(root.querySelectorAll("svg")).filter(
      (node: any) =>
        typeof node?.outerHTML === "string" &&
        !(typeof node?.closest === "function" && node.closest("[data-export-ignore]")),
    );
    if (all.length > 0) {
      svgEl = all.reduce((best, cur) => (cur.outerHTML.length > best.outerHTML.length ? cur : best), all[0]);
    }
  }
  if (!svgEl) {
    svgEl = root?.querySelector?.("svg");
  }
  if (!svgEl || typeof svgEl.outerHTML !== "string") {
    throw new Error("no <svg> element found to export");
  }
  return resolveSvgMarkup(svgEl.outerHTML, tokens);
}

export async function renderElementToSvg(
  el: HTMLElement | SVGElement | { tagName?: string; outerHTML?: string; querySelector?: (sel: string) => any },
  tokenMap?: Record<string, string>,
): Promise<string> {
  const tokens = collectComputedSvgTokens(el, tokenMap);
  if ((el as { tagName?: string })?.tagName?.toLowerCase() === "svg") {
    return serializeSvgElement(el, tokens);
  }

  const hasBrowserLayout =
    typeof window !== "undefined" &&
    typeof document !== "undefined" &&
    typeof (el as HTMLElement)?.getBoundingClientRect === "function" &&
    (el as HTMLElement).getBoundingClientRect().width > 0 &&
    (el as HTMLElement).getBoundingClientRect().height > 0;

  if (hasBrowserLayout) {
    const htmlEl = el as HTMLElement;
    const { toSvg } = await import("html-to-image");
    const bg =
      (typeof window.getComputedStyle === "function" && window.getComputedStyle(htmlEl).backgroundColor) ||
      tokens["--surface"] ||
      "#ffffff";
    const dataUrl = await Promise.race([
      toSvg(htmlEl, {
        backgroundColor: bg === "rgba(0, 0, 0, 0)" || bg === "transparent" ? tokens["--surface"] || "#ffffff" : bg,
        skipFonts: true,
        filter: (node: HTMLElement) =>
          !(
            typeof Element !== "undefined" &&
            node instanceof Element &&
            (node.matches("[data-export-ignore]") || Boolean(node.closest("[data-export-ignore]")))
          ),
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("rendering vector SVG took too long")), 15000),
      ),
    ]);
    const decoded = decodeSvgDataUrl(dataUrl);
    return resolveSvgMarkup(decoded, tokens);
  }

  return serializeSvgElement(el, tokens);
}

export async function downloadSvg(
  filename: string,
  el: HTMLElement | SVGElement,
  tokenMap?: Record<string, string>,
): Promise<string> {
  const serialized = await renderElementToSvg(el, tokenMap);
  downloadBlob(filename, new Blob([serialized], { type: "image/svg+xml;charset=utf-8" }));
  return serialized;
}
