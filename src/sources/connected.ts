import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { LINEAGE_COLUMNS, type Column, type Metric, type Model, type Table, type TimeGrain } from "../semantic/model.ts";
import { timeDimensionIssue } from "../semantic/duckglue.ts";

/**
 * The per-source overlay of tables Ingest registered ("Connected to Semantic
 * Canvas", docs/connected-canvas.md). One YAML file per source under
 * SC_DATA_DIR/models/connected/, merged over the base model when the source
 * loads. Base model files are never edited; a base table with the same name
 * always wins.
 */
const DATASET = /^[a-z][a-z0-9_]{0,62}$/;
const SOURCE = /^[a-z][a-z0-9-]{1,40}$/;
const grains = z.array(z.enum(["day", "week", "month", "quarter", "year"])).min(1);
const columnSchema = z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128), type: z.string().min(1).max(64), description: z.string().max(2000).optional() }).strict();
const tableSchema = z.object({
  description: z.string().max(4000).optional(), grain: z.string().max(400).optional(), synonyms: z.array(z.string().max(120)).max(50).optional(),
  primary_key: z.string().max(128).nullable().optional(), columns: z.array(columnSchema).min(1).max(1000), default_date_column: z.string().max(128).optional(),
}).strict();
const draftMetricSchema = z.object({ label: z.string().min(1).max(200), expression: z.string().min(1).max(4000), description: z.string().max(2000).optional() }).strict();
const reviewFields = { time_grains: grains.optional(), time_dimension: z.string().max(200).optional(), direction: z.enum(["higher", "lower", "neutral"]).optional(), importance: z.number().min(0).max(100).optional() };
const metricEntrySchema = draftMetricSchema.extend({ reviewed: z.boolean(), ...reviewFields }).strict();
/** `refreshEvery`/`expectedBy` arrive when Ingest refreshes the table on a schedule: how often, and when the next load is due. */
export const provenanceSchema = z.object({ source: z.string().min(1).max(200), loadedAt: z.string().datetime({ offset: true }), loadedBy: z.string().min(1).max(200), rows: z.number().int().nonnegative(),
  refreshEvery: z.enum(["15m", "1h", "6h", "12h", "1d", "7d"]).optional(), expectedBy: z.string().datetime({ offset: true }).optional() }).strict();
export const registerSchema = z.object({
  dataset: z.string().regex(DATASET, "dataset must be lowercase letters, digits and underscores, starting with a letter"),
  importId: z.string().min(1).max(200), table: tableSchema,
  metrics: z.record(z.string().regex(DATASET), draftMetricSchema).default({}), provenance: provenanceSchema,
}).strict();
export const publishSchema = z.object({
  metrics: z.record(z.string(), z.object({ reviewed: z.literal(true), label: z.string().min(1).max(200).optional(), description: z.string().max(2000).optional(), ...reviewFields }).strict()).default({}),
  table: z.object({ grain: z.string().max(400).optional(), description: z.string().max(4000).optional(), default_date_column: z.string().max(128).optional() }).strict().optional(),
}).strict();
const entrySchema = z.object({
  status: z.enum(["unreviewed", "published"]), dataset: z.string().regex(DATASET), importId: z.string(), provenance: provenanceSchema,
  registeredBy: z.string().min(1), table: tableSchema, metrics: z.record(z.string(), metricEntrySchema).default({}),
}).strict();
const overlaySchema = z.object({ tables: z.record(z.string(), entrySchema).default({}) }).strict();
export type ConnectedEntry = z.infer<typeof entrySchema>;
export type Overlay = z.infer<typeof overlaySchema>;

export const connectedDir = () => resolve(process.env.SC_DATA_DIR ?? resolve(homedir(), ".semantic-canvas"), "models", "connected");
function overlayPath(sourceId: string) {
  if (!SOURCE.test(sourceId)) throw Object.assign(new Error(`invalid source id "${sourceId}"`), { status: 400 });
  return resolve(connectedDir(), `${sourceId}.yaml`);
}

export async function readOverlay(sourceId: string): Promise<Overlay> {
  let raw: string;
  try { raw = await readFile(overlayPath(sourceId), "utf8"); } catch (e: any) { if (e?.code === "ENOENT") return { tables: {} }; throw e; }
  return overlaySchema.parse(YAML.parse(raw, { maxAliasCount: 50 }) ?? {});
}

/** Atomic (temp + rename), owner-only; serialised by the caller through the config queue. */
export async function writeOverlay(sourceId: string, overlay: Overlay) {
  const path = overlayPath(sourceId), temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(connectedDir(), { recursive: true, mode: 0o700 });
  await writeFile(temporary, YAML.stringify(overlaySchema.parse(overlay), { lineWidth: 0 }), { mode: 0o600, flag: "wx" });
  try { await rename(temporary, path); } catch (e) { await unlink(temporary).catch(() => {}); throw e; }
}

/** Only the table's own date columns can carry a restricted grain; same rule as duckglue.ts. */
export function metricIssues(entry: Pick<ConnectedEntry, "dataset" | "table" | "metrics">): string | null {
  const table = entryTable(entry);
  for (const [name, m] of Object.entries(entry.metrics)) {
    const issue = timeDimensionIssue(name, entry.dataset, table, m.time_grains, m.time_dimension);
    if (issue) return issue;
  }
  if (entry.table.default_date_column && !table.columns.some((c) => c.name === entry.table.default_date_column && /date|timestamp/i.test(c.type)))
    return `default_date_column must name a date column of ${entry.dataset}`;
  return null;
}

function entryTable(entry: Pick<ConnectedEntry, "dataset" | "table"> & Partial<Pick<ConnectedEntry, "status" | "provenance">>): Table {
  const declared = entry.table.columns.map((c): Column => ({ name: c.name, type: c.type, description: c.description }));
  return {
    name: entry.dataset, description: (entry.table.description ?? "").trim(), grain: entry.table.grain ?? "", synonyms: entry.table.synonyms ?? [],
    partitionKeys: [], primaryKey: entry.table.primary_key ?? null, relation: { table: entry.dataset },
    columns: [...declared, ...LINEAGE_COLUMNS.filter((l) => !declared.some((c) => c.name === l.name))],
    ...(entry.status && entry.provenance ? { connected: { status: entry.status, provenance: entry.provenance, loadedAt: entry.provenance.loadedAt } } : {}),
  };
}

/** Merge the overlay into a freshly loaded base model. Returns the same object when there is nothing to merge. */
export function mergeOverlay(model: Model, overlay: Overlay, sourceId: string): Model {
  const entries = Object.values(overlay.tables);
  if (!entries.length) return model;
  const tables = { ...model.tables }, metrics = { ...model.metrics };
  for (const entry of entries) {
    if (tables[entry.dataset]) {
      console.error(JSON.stringify({ event: "connected.table_shadowed", level: "warn", source: sourceId, dataset: entry.dataset }));
      continue;
    }
    tables[entry.dataset] = entryTable(entry);
    for (const [name, m] of Object.entries(entry.metrics)) {
      if (metrics[name]) { console.error(JSON.stringify({ event: "connected.metric_shadowed", level: "warn", source: sourceId, dataset: entry.dataset, metric: name })); continue; }
      metrics[name] = {
        name, label: m.label, description: (m.description ?? "").trim(), baseTable: entry.dataset, expression: m.expression,
        timeGrains: m.time_grains as TimeGrain[] | undefined, timeDimension: m.time_dimension, direction: m.direction, importance: m.importance,
        filter: null, synonyms: [], reviewed: m.reviewed,
      } satisfies Metric;
    }
  }
  return { ...model, tables, metrics };
}

/** What the API lists per entry: status and provenance, never the expressions. */
export const summarize = (e: ConnectedEntry) => ({
  dataset: e.dataset, status: e.status, importId: e.importId, provenance: e.provenance, loadedAt: e.provenance.loadedAt, registeredBy: e.registeredBy,
  columns: e.table.columns.length, metrics: Object.entries(e.metrics).map(([name, m]) => ({ name, label: m.label, reviewed: m.reviewed })),
});
