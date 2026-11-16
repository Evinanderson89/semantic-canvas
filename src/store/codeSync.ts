import YAML from "yaml";
import { validateDashboard } from "../app/filters.ts";
import { DEFAULT_CANVAS, type CanvasSpec } from "../canvas/presets.ts";
import { canvasSchema, dashboardSchema } from "../compiler/schema.ts";
import type { DashboardSpec, TileSpec } from "../compiler/spec.ts";
import type { Model } from "../semantic/model.ts";

export interface DashboardCodeDocument {
  id: string;
  name: string;
  spec: DashboardSpec;
  canvas: CanvasSpec;
}

export interface DashboardSpecDiff {
  titleChanged: boolean;
  descriptionChanged: boolean;
  addedTiles: string[];
  removedTiles: string[];
  modifiedTiles: { id: string; changes: string[] }[];
  filterChanges: { added: string[]; removed: string[] };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) {
        out[key] = canonicalize(entry);
      }
    }
    return out;
  }
  return value;
}

export function dashboardToYaml(doc: DashboardCodeDocument): string {
  const payload = {
    version: 1,
    id: doc.id,
    name: doc.name,
    spec: canonicalize(doc.spec),
    canvas: canonicalize(doc.canvas),
  };
  return YAML.stringify(payload, { lineWidth: 0 });
}

export function dashboardFromYaml(yamlText: string, model?: Model): DashboardCodeDocument {
  let raw: unknown;
  try {
    raw = YAML.parse(yamlText, { maxAliasCount: 50 });
  } catch (e: any) {
    throw Object.assign(new Error(`Invalid dashboard YAML: ${String(e?.message ?? e)}`), { status: 400 });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw Object.assign(new Error("Dashboard YAML must be a mapping object"), { status: 400 });
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== undefined && obj.version !== 1) {
    throw Object.assign(new Error(`Unsupported dashboard YAML version: ${String(obj.version)}`), { status: 400 });
  }
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  if (!id) {
    throw Object.assign(new Error("Dashboard YAML requires a non-empty id"), { status: 400 });
  }
  const spec = dashboardSchema.parse(obj.spec);
  const canvas = canvasSchema.parse(obj.canvas ?? DEFAULT_CANVAS);
  const name = typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : spec.title;

  if (model) {
    const issues = validateDashboard(model, spec);
    if (issues.length) {
      throw Object.assign(
        new Error(issues.map((i) => `${i.tile}: ${i.problem}`).join("; ")),
        { status: 400, issues },
      );
    }
  }

  return { id, name, spec, canvas };
}

const TILE_COMPARED_KEYS: (keyof TileSpec)[] = [
  "title",
  "kind",
  "metrics",
  "dimensions",
  "where",
  "chart",
  "compare",
  "compareShow",
  "limit",
  "layout",
  "format",
  "spark",
  "text",
  "section",
  "tabId",
  "filterId",
  "pinned",
  "imageData",
  "evidence",
];

export function diffDashboardSpecs(before: DashboardSpec, after: DashboardSpec): DashboardSpecDiff {
  const titleChanged = before.title !== after.title;
  const descriptionChanged = (before.description ?? "") !== (after.description ?? "");

  const beforeById = new Map(before.tiles.map((t) => [t.id, t]));
  const afterById = new Map(after.tiles.map((t) => [t.id, t]));

  const addedTiles = after.tiles.filter((t) => !beforeById.has(t.id)).map((t) => t.id);
  const removedTiles = before.tiles.filter((t) => !afterById.has(t.id)).map((t) => t.id);

  const modifiedTiles: { id: string; changes: string[] }[] = [];
  for (const afterTile of after.tiles) {
    const beforeTile = beforeById.get(afterTile.id);
    if (!beforeTile) continue;
    const changes: string[] = [];
    for (const key of TILE_COMPARED_KEYS) {
      const a = JSON.stringify(canonicalize(beforeTile[key]));
      const b = JSON.stringify(canonicalize(afterTile[key]));
      if (a !== b) {
        changes.push(key);
      }
    }
    if (changes.length > 0) {
      modifiedTiles.push({ id: afterTile.id, changes });
    }
  }

  const beforeFilterIds = new Set((before.filters ?? []).map((f) => f.id));
  const afterFilterIds = new Set((after.filters ?? []).map((f) => f.id));
  const addedFilters = (after.filters ?? []).filter((f) => !beforeFilterIds.has(f.id)).map((f) => f.id);
  const removedFilters = (before.filters ?? []).filter((f) => !afterFilterIds.has(f.id)).map((f) => f.id);

  return {
    titleChanged,
    descriptionChanged,
    addedTiles,
    removedTiles,
    modifiedTiles,
    filterChanges: {
      added: addedFilters,
      removed: removedFilters,
    },
  };
}
