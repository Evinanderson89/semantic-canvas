import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import type { Proposal } from "./propose.ts";

/**
 * A Modeler draft: the proposal as reviewed so far, plus where it came
 * from. One JSON file per draft under SC_DATA_DIR/models/drafts/; the
 * published model file lives beside it under models/authored/<id>.yaml and
 * is what the source's `model:` points at. A draft's connector config is
 * stored exactly as sources.yaml would hold it (${VAR} references, never a
 * secret), so publishing can hand it straight to the source registry.
 */
const ID = /^[a-z][a-z0-9-]{1,40}$/;
const ident = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128);
const proposalSchema = z.object({
  model: z.object({ name: z.string().min(1).max(200), description: z.string().max(4000) }).strict(),
  tables: z.array(z.object({
    name: ident, include: z.boolean(), status: z.enum(["new", "existing", "gap"]).optional(), kind: z.enum(["fact", "dimension", "unknown"]), grain: z.string().max(400), evidence: z.string().max(2000),
    primaryKey: ident.nullable(), description: z.string().max(4000), synonyms: z.array(z.string().max(120)).max(50), timeColumn: ident.nullable(),
    reportingLag: z.number().int().min(0).max(365).optional(),
    columns: z.array(z.object({ name: ident, type: z.string().min(1).max(64), description: z.string().max(2000) }).strict()).max(1000), rows: z.number().int().nonnegative(),
  }).strict()).max(500),
  joins: z.array(z.object({ left: ident, leftOn: ident, right: ident, rightOn: ident, type: z.enum(["left", "inner"]), include: z.boolean(), status: z.enum(["new", "existing", "gap"]).optional(), evidence: z.string().max(2000), resolution: z.number().min(0).max(1).nullable() }).strict()).max(2000),
  metrics: z.array(z.object({ name: z.string().max(128), label: z.string().max(200), baseTable: ident, expression: z.string().max(4000), description: z.string().max(2000), include: z.boolean(), status: z.enum(["new", "existing", "gap"]).optional(), evidence: z.string().max(2000) }).strict()).max(2000),
  warnings: z.array(z.string().max(2000)).max(500),
  extends: z.string().regex(ID).optional(),
}).strict();
const driftSchema = z.array(z.object({ table: ident, column: ident.nullable(), kind: z.enum(["table_missing", "column_missing", "type_changed"]), declared: z.string().max(64).nullable(), actual: z.string().max(64).nullable(), metrics: z.array(z.string().max(128)).max(1000), text: z.string().max(2000) }).strict()).max(5000);
export const draftSchema = z.object({
  id: z.string().regex(ID), label: z.string().min(1).max(200),
  /** The connector as sources.yaml holds it, or the source whose connector the draft borrows. */
  connector: z.record(z.string(), z.unknown()).optional(), fromSource: z.string().regex(ID).optional(),
  createdAt: z.string(), createdBy: z.string().max(200), updatedAt: z.string(),
  publishedAt: z.string().nullable(), sourceId: z.string().regex(ID).nullable(),
  proposal: proposalSchema,
  /** For an extension draft: what the warehouse no longer has that the model declares, as read when the draft was made. */
  drift: driftSchema.optional(),
}).strict();
export type Draft = z.infer<typeof draftSchema>;
/** What a person may change on review: the proposal itself, and the label. */
export const draftPatchSchema = z.object({ label: z.string().min(1).max(200).optional(), proposal: proposalSchema.optional() }).strict();

const dataDir = () => process.env.SC_DATA_DIR ?? resolve(homedir(), ".semantic-canvas");
export const draftsDir = () => resolve(dataDir(), "models", "drafts");
export const authoredDir = () => resolve(dataDir(), "models", "authored");
export const authoredPath = (id: string) => { if (!ID.test(id)) throw Object.assign(new Error(`invalid model id "${id}"`), { status: 400 }); return resolve(authoredDir(), `${id}.yaml`); };
const draftPath = (id: string) => { if (!ID.test(id)) throw Object.assign(new Error(`invalid draft id "${id}"`), { status: 400 }); return resolve(draftsDir(), `${id}.json`); };

export async function listDrafts(): Promise<Draft[]> {
  const names = await readdir(draftsDir()).catch(() => [] as string[]);
  const out: Draft[] = [];
  for (const n of names) if (n.endsWith(".json")) { const d = await readDraft(n.slice(0, -5)).catch(() => null); if (d) out.push(d); }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readDraft(id: string): Promise<Draft | null> {
  let raw: string;
  try { raw = await readFile(draftPath(id), "utf8"); } catch (e: any) { if (e?.code === "ENOENT") return null; throw e; }
  return draftSchema.parse(JSON.parse(raw));
}

/** Atomic (temp + rename), owner-only. */
export async function writeDraft(d: Draft) {
  const path = draftPath(d.id), temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(draftsDir(), { recursive: true, mode: 0o700 });
  await writeFile(temporary, JSON.stringify(draftSchema.parse(d), null, 2), { mode: 0o600, flag: "wx" });
  try { await rename(temporary, path); } catch (e) { await unlink(temporary).catch(() => {}); throw e; }
}

export async function removeDraft(id: string) { await unlink(draftPath(id)).catch((e) => { if (e?.code !== "ENOENT") throw e; }); }

export async function writeAuthored(id: string, yaml: string) {
  const path = authoredPath(id), temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(authoredDir(), { recursive: true, mode: 0o700 });
  await writeFile(temporary, yaml, { mode: 0o600, flag: "wx" });
  try { await rename(temporary, path); } catch (e) { await unlink(temporary).catch(() => {}); throw e; }
  return path;
}

/** The list view: never the proposal body. */
export const summarizeDraft = (d: Draft) => ({
  id: d.id, label: d.label, createdAt: d.createdAt, createdBy: d.createdBy, updatedAt: d.updatedAt, publishedAt: d.publishedAt, sourceId: d.sourceId,
  fromSource: d.fromSource ?? null, connector: d.connector ? String(d.connector.type ?? "") : null, extends: d.proposal.extends ?? null, drift: (d.drift ?? []).length,
  tables: d.proposal.tables.filter((t) => t.include).length, joins: d.proposal.joins.filter((j) => j.include).length, metrics: d.proposal.metrics.filter((m) => m.include).length, warnings: d.proposal.warnings.length,
});
export type Draft_ = Draft;
export type { Proposal };
