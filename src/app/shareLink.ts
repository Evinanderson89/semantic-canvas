import { SAMPLE_WORKBOOKS, type SampleWorkbookId } from "../modeler/spreadsheetTypes.ts";
import { PRESET_IDS } from "./datePresets.ts";
import type { DatePreset } from "../compiler/spec.ts";
import type { PresentationMode } from "./ReportPresentation.tsx";

export interface ShareLinkState {
  starter: string | null;
  dash: string | null;
  mode: PresentationMode | null;
  detail: string | null;
  story: boolean;
  sample: SampleWorkbookId | null;
  auto: boolean;
  window: DatePreset | "all" | null;
}

const VALID_MODES = new Set<PresentationMode>(["dashboard", "story", "infographic"]);
const VALID_SAMPLES = new Set<SampleWorkbookId>(SAMPLE_WORKBOOKS.map((w) => w.id));
const VALID_WINDOWS = new Set<string>(["all", ...PRESET_IDS]);
const WINDOW_ALIASES: Record<string, DatePreset> = {
  "7d": "last-7-days",
  "30d": "last-30-days",
  "90d": "last-90-days",
  "ytd": "year-to-date",
};

export function slugStarter(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function resolveStarterName(raw: string | null, starterNames: string[]): string | null {
  if (!raw) return null;
  const target = raw.trim().toLowerCase();
  const slug = slugStarter(raw);
  return starterNames.find((n) => n.toLowerCase() === target || slugStarter(n) === slug) ?? null;
}

export function parseShareLink(search: string): ShareLinkState | null {
  const p = new URLSearchParams(search);
  const starter = p.get("starter")?.trim() || null;
  const dash = p.get("dash")?.trim() || null;
  const rawMode = p.get("mode")?.trim().toLowerCase() || "";
  const mode = VALID_MODES.has(rawMode as PresentationMode) ? (rawMode as PresentationMode) : null;
  const detail = p.get("detail")?.trim() || null;
  const story = p.get("story") === "1" || p.get("story") === "true";
  const rawSample = p.get("sample")?.trim() || "";
  const sample = VALID_SAMPLES.has(rawSample as SampleWorkbookId) ? (rawSample as SampleWorkbookId) : null;
  const auto = p.get("auto") === "1" || p.get("auto") === "true";
  const rawWindow = p.get("window")?.trim().toLowerCase() || "";
  const win = WINDOW_ALIASES[rawWindow] ?? (VALID_WINDOWS.has(rawWindow) ? (rawWindow as DatePreset | "all") : null);

  if (!starter && !dash && !mode && !detail && !sample && !win) return null;
  return { starter, dash, mode, detail, story, sample, auto, window: win };
}

export function stripShareLink(href: string): string {
  const url = new URL(href);
  for (const key of ["starter", "dash", "mode", "detail", "story", "sample", "auto", "window"]) {
    url.searchParams.delete(key);
  }
  return url.href;
}

export function buildShareUrl(
  baseHref: string,
  opts: {
    starterTitle?: string | null;
    dashId?: string | null;
    sourceId?: string | null;
    mode?: PresentationMode | null;
    detail?: string | null;
    story?: boolean;
    sample?: SampleWorkbookId | null;
    auto?: boolean;
    dateWindow?: DatePreset | "all";
  },
): string {
  const url = new URL(stripShareLink(baseHref));
  url.hash = "";
  if (opts.sample) {
    url.searchParams.set("sample", opts.sample);
    if (opts.auto) url.searchParams.set("auto", "1");
    return url.href;
  }
  if (opts.sourceId && opts.sourceId !== "duckglue-local") {
    url.searchParams.set("source", opts.sourceId);
  }
  if (opts.dashId) {
    url.searchParams.set("dash", opts.dashId);
  } else if (opts.starterTitle) {
    url.searchParams.set("starter", slugStarter(opts.starterTitle));
  }
  if (opts.dateWindow && opts.dateWindow !== "all") {
    url.searchParams.set("window", opts.dateWindow);
  }
  if (opts.mode && opts.mode !== "dashboard") {
    url.searchParams.set("mode", opts.mode);
  }
  if (opts.detail) {
    url.searchParams.set("detail", opts.detail);
    if (opts.story) url.searchParams.set("story", "1");
  }
  return url.href;
}
