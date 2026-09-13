import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { Join, Metric, Model, Origin, Table } from "../semantic/model.ts";

/**
 * A model extension: what the Modeler added to a source whose base model
 * comes from somewhere else (a dbt project, a Snowflake semantic view, a
 * hand-written file). One YAML file per source under
 * SC_DATA_DIR/models/extensions/, in the duckglue vocabulary, merged over
 * the base model when the source loads. The base file is never edited; a
 * base table, join or metric with the same name always wins, and the only
 * thing an extension may say about a base table is its reporting lag.
 */
const SOURCE = /^[a-z][a-z0-9-]{1,40}$/;
const ident = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128);
const originSchema = z.object({ kind: z.enum(["modeler", "proposal"]), by: z.string().min(1).max(200), by_id: z.string().max(200).optional(), at: z.string(), published_by: z.string().max(200).optional(), published_at: z.string().optional() }).strict();
const columnSchema = z.object({ name: ident, type: z.string().min(1).max(64), description: z.string().max(2000).optional() }).strict();
const tableSchema = z.object({
  description: z.string().max(4000).optional(), grain: z.string().max(400), synonyms: z.array(z.string().max(120)).max(50).optional(),
  primary_key: ident.nullable().optional(), reporting_lag: z.number().int().min(0).max(365).optional(), default_date_column: ident.optional(),
  columns: z.array(columnSchema).min(1).max(1000),
  origin: originSchema.optional(),
}).strict();
const joinSchema = z.object({ left: ident, left_on: ident, right: ident, right_on: ident, type: z.enum(["left", "inner"]).default("left") }).strict();
const metricSchema = z.object({
  label: z.string().min(1).max(200), base_table: ident, expression: z.string().min(1).max(4000), description: z.string().max(2000).optional(), synonyms: z.array(z.string().max(120)).max(50).optional(),
  filter: z.string().max(4000).nullable().optional(),
  /** false on a metric an editor proposed that no administrator has published; absent counts as reviewed. */
  reviewed: z.boolean().optional(),
  origin: originSchema.optional(),
}).strict();
export const extensionSchema = z.object({
  tables: z.record(ident, tableSchema).default({}),
  joins: z.array(joinSchema).default([]),
  metrics: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), metricSchema).default({}),
  /** What an extension may say about a table the base model owns. */
  patches: z.record(ident, z.object({ reporting_lag: z.number().int().min(0).max(365).optional() }).strict()).default({}),
}).strict();
export type Extension = z.infer<typeof extensionSchema>;

export const extensionsDir = () => resolve(process.env.SC_DATA_DIR ?? resolve(homedir(), ".semantic-canvas"), "models", "extensions");
export function extensionPath(sourceId: string) {
  if (!SOURCE.test(sourceId)) throw Object.assign(new Error(`invalid source id "${sourceId}"`), { status: 400 });
  return resolve(extensionsDir(), `${sourceId}.yaml`);
}

export async function readExtension(sourceId: string): Promise<Extension | null> {
  let raw: string;
  try { raw = await readFile(extensionPath(sourceId), "utf8"); } catch (e: any) { if (e?.code === "ENOENT") return null; throw e; }
  return extensionSchema.parse(YAML.parse(raw, { maxAliasCount: 50 }) ?? {});
}

/** Atomic (temp + rename), owner-only. */
export async function writeExtension(sourceId: string, yaml: string): Promise<string> {
  extensionSchema.parse(YAML.parse(yaml, { maxAliasCount: 50 }) ?? {});
  const path = extensionPath(sourceId), temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(extensionsDir(), { recursive: true, mode: 0o700 });
  await writeFile(temporary, yaml, { mode: 0o600, flag: "wx" });
  try { await rename(temporary, path); } catch (e) { await unlink(temporary).catch(() => {}); throw e; }
  return path;
}

/** Merge an extension over a loaded base model. Returns the same object when there is nothing to merge; a base name always wins and is logged. */
export function mergeExtension(model: Model, ext: Extension | null, sourceId: string): Model {
  if (!ext) return model;
  const tables: Record<string, Table> = { ...model.tables }, metrics: Record<string, Metric> = { ...model.metrics }, joins: Join[] = [...model.joins];
  const warn = (event: string, detail: Record<string, string>) => console.error(JSON.stringify({ event, level: "warn", source: sourceId, ...detail }));
  for (const [name, t] of Object.entries(ext.tables)) {
    if (tables[name]) { warn("extension.table_shadowed", { table: name }); continue; }
    tables[name] = {
      name, description: (t.description ?? "").trim(), grain: t.grain, synonyms: t.synonyms ?? [], partitionKeys: [], primaryKey: t.primary_key ?? null,
      reportingLagDays: t.reporting_lag, relation: { table: name }, columns: t.columns.map((c) => ({ name: c.name, type: c.type, description: c.description })),
      ...(t.origin ? { origin: fromOrigin(t.origin) } : {}),
    };
  }
  for (const [name, patch] of Object.entries(ext.patches)) {
    if (!tables[name]) { warn("extension.patch_orphaned", { table: name }); continue; }
    if (patch.reporting_lag !== undefined && tables[name].reportingLagDays === undefined) tables[name] = { ...tables[name], reportingLagDays: patch.reporting_lag };
  }
  for (const j of ext.joins) {
    if (!tables[j.left] || !tables[j.right]) { warn("extension.join_orphaned", { left: j.left, right: j.right }); continue; }
    const dup = joins.some((k) => (k.left === j.left && k.leftOn === j.left_on && k.right === j.right && k.rightOn === j.right_on) || (k.left === j.right && k.leftOn === j.right_on && k.right === j.left && k.rightOn === j.left_on));
    if (!dup) joins.push({ left: j.left, leftOn: j.left_on, right: j.right, rightOn: j.right_on, type: j.type });
  }
  for (const [name, m] of Object.entries(ext.metrics)) {
    if (metrics[name]) { warn("extension.metric_shadowed", { metric: name }); continue; }
    if (!tables[m.base_table]) { warn("extension.metric_orphaned", { metric: name }); continue; }
    metrics[name] = { name, label: m.label, description: (m.description ?? "").trim(), baseTable: m.base_table, expression: m.expression, filter: m.filter ?? null, synonyms: m.synonyms ?? [],
      ...(m.reviewed === false ? { reviewed: false } : {}), ...(m.origin ? { origin: fromOrigin(m.origin) } : {}) };
  }
  return { ...model, tables, metrics, joins };
}

const fromOrigin = (o: NonNullable<Extension["metrics"][string]["origin"]>): Origin => ({ kind: o.kind, by: o.by, byId: o.by_id, at: o.at, publishedBy: o.published_by, publishedAt: o.published_at });

/** Read-modify-write one source's extension under the caller's queue; creates it when absent. */
export async function updateExtension(sourceId: string, change: (ext: Extension) => Extension | Promise<Extension>): Promise<Extension> {
  const current = (await readExtension(sourceId)) ?? extensionSchema.parse({});
  const next = extensionSchema.parse(await change(current));
  await writeExtension(sourceId, YAML.stringify(next, { lineWidth: 0 }));
  return next;
}
