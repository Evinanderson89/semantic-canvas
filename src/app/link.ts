/**
 * "Open in Semantic Canvas" links (docs/connected-canvas.md) carry
 * ?source=<id>&table=<name>. Both are read once on load and stripped from the
 * URL; an unknown or unavailable source is ignored, never an error.
 */
export interface CanvasLink { source: string | null; table: string | null }

export function parseLink(search: string): CanvasLink {
  const p = new URLSearchParams(search);
  return { source: p.get("source")?.trim() || null, table: p.get("table")?.trim() || null };
}

export function stripLink(href: string): string {
  const url = new URL(href);
  url.searchParams.delete("source"); url.searchParams.delete("table");
  return url.href;
}

/** The source a link selects: one the caller knows and that is ready; anything else is ignored. */
export function linkedSource(link: CanvasLink, sources: { id: string; status: string }[]): string | null {
  return link.source && sources.some((s) => s.id === link.source && s.status === "ready") ? link.source : null;
}
