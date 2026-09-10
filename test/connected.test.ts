import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connectOne } from "../src/sources/registry.ts";
import { mergeOverlay, metricIssues, readOverlay, registerSchema, writeOverlay, type Overlay } from "../src/sources/connected.ts";
import { suggestDashboard } from "../src/suggest/suggest.ts";
import { reviewedModel, visibleModel, type Model } from "../src/semantic/model.ts";
import { validateTile } from "../src/compiler/compile.ts";
import { model as fixture } from "./fixtures.ts";

let root = "", previous: string | undefined;
const entry = (dataset: string, status: "unreviewed" | "published", over: Record<string, any> = {}): Overlay["tables"][string] => ({
  status, dataset, importId: "imp-1", registeredBy: "casey",
  provenance: { source: "Salesforce Account", loadedAt: "2026-09-10T15:00:00Z", loadedBy: "casey@example.test", rows: 1204 },
  table: { description: "Accounts", grain: "one row per account", synonyms: ["accounts"], primary_key: "id", default_date_column: "created_date",
    columns: [{ name: "id", type: "string" }, { name: "industry", type: "string" }, { name: "employees", type: "bigint" }, { name: "created_date", type: "date" }] },
  metrics: { [`${dataset}_rows`]: { label: "Accounts", expression: "count(*)", reviewed: false },
             [`${dataset}_employees_total`]: { label: "Employees", expression: "sum(employees)", reviewed: false } },
  ...over,
});

beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "sc-connected-")); previous = process.env.SC_DATA_DIR; process.env.SC_DATA_DIR = root; });
afterAll(async () => { if (previous === undefined) delete process.env.SC_DATA_DIR; else process.env.SC_DATA_DIR = previous; await rm(root, { recursive: true, force: true }); });

it("writes the overlay atomically with owner-only permissions and reads it back", async () => {
  await writeOverlay("sample", { tables: { salesforce_account: entry("salesforce_account", "unreviewed") } });
  const path = join(root, "models", "connected", "sample.yaml");
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await readFile(path, "utf8")).toContain("salesforce_account");
  expect(Object.keys((await readOverlay("sample")).tables)).toEqual(["salesforce_account"]);
  expect((await readOverlay("missing")).tables).toEqual({});
  await expect(readOverlay("../escape")).rejects.toThrow(/invalid source id/);
});

it("merges overlay tables and metrics into the loaded model with lineage columns; a base table wins", async () => {
  await writeOverlay("sample", { tables: {
    salesforce_account: entry("salesforce_account", "unreviewed"),
    fct_events: entry("fct_events", "published"),
  } });
  const source = await connectOne({ id: "sample", adapter: "duckglue", model: resolve("sample-data/warehouse.yaml"), connector: { type: "duckdb", lakeRoot: resolve("sample-data/lake"), poolSize: 1 } });
  await source.conn?.close();
  expect(source.status, source.error).toBe("ready");
  const model = source.model!, table = model.tables.salesforce_account;
  expect(table.connected).toMatchObject({ status: "unreviewed", loadedAt: "2026-09-10T15:00:00Z", provenance: { rows: 1204 } });
  expect(table.partitionKeys).toEqual([]); expect(table.primaryKey).toBe("id"); expect(table.relation).toEqual({ table: "salesforce_account" });
  expect(table.columns.map(c => c.name)).toEqual(["id", "industry", "employees", "created_date", "_import_id", "_loaded_at", "_source"]);
  expect(model.metrics.salesforce_account_rows).toMatchObject({ baseTable: "salesforce_account", expression: "count(*)", reviewed: false, filter: null });
  // The base model's fct_events is untouched: no connected marker, its own columns, its own metrics.
  expect(model.tables.fct_events.connected).toBeUndefined();
  expect(model.tables.fct_events.columns.some(c => c.name === "industry")).toBe(false);
  expect(model.metrics.fct_events_rows).toBeUndefined();
  expect(model.metrics.event_count.reviewed).toBeUndefined();
});

it("keeps unreviewed tables out of suggestions and viewer sessions while published ones show", () => {
  const overlay: Overlay = { tables: {
    salesforce_account: entry("salesforce_account", "unreviewed"),
    stripe_invoices: entry("stripe_invoices", "published", { metrics: {
      stripe_invoices_rows: { label: "Invoices", expression: "count(*)", reviewed: true, time_grains: ["month"], time_dimension: "stripe_invoices.created_date" },
      stripe_invoices_employees_total: { label: "Draft total", expression: "sum(employees)", reviewed: false },
    } }),
  } };
  const merged = mergeOverlay(fixture, overlay, "t");
  expect(Object.keys(merged.tables)).toContain("salesforce_account");
  const viewer = visibleModel(merged, "viewer");
  expect(viewer.tables.salesforce_account).toBeUndefined(); expect(viewer.metrics.salesforce_account_rows).toBeUndefined();
  expect(viewer.tables.stripe_invoices.connected?.status).toBe("published");
  expect(viewer.metrics.stripe_invoices_rows).toBeDefined(); expect(viewer.metrics.stripe_invoices_employees_total).toBeUndefined();
  expect(visibleModel(merged, "editor")).toBe(merged); expect(reviewedModel(fixture)).toBe(fixture);
  const suggested = suggestDashboard(merged, { table: "salesforce_account" });
  const used = new Set(suggested.tiles.flatMap(t => t.metrics));
  expect(used.has("salesforce_account_rows")).toBe(false);
  const published = suggestDashboard(merged, { table: "stripe_invoices" });
  expect(published.tiles.flatMap(t => t.metrics)).toContain("stripe_invoices_rows");
  expect(published.tiles.flatMap(t => t.metrics)).not.toContain("stripe_invoices_employees_total");
  expect(published.tiles.flatMap(t => t.dimensions).some(d => /_source|_import_id|_loaded_at/.test(d))).toBe(false);
  const tile = { id: "q", metrics: ["salesforce_account_rows"], dimensions: [], layout: { x: 0, y: 0, w: 1, h: 1 } };
  expect(validateTile(merged, tile, { role: "viewer" }).map(i => i.problem)).toEqual([expect.stringContaining("not yet published")]);
  expect(validateTile(merged, tile, { role: "editor" })).toEqual([]);
  expect(validateTile(merged, { ...tile, metrics: ["stripe_invoices_employees_total"] }, { role: "viewer" })).toHaveLength(1);
  expect(validateTile(merged, { ...tile, metrics: ["stripe_invoices_rows"], dimensions: ["month:created_date"] }, { role: "viewer" })).toEqual([]);
});

it("validates registration bodies and reviewed time dimensions the way duckglue does", () => {
  const body = { dataset: "salesforce_account", importId: "imp-1", table: entry("salesforce_account", "unreviewed").table,
    metrics: { salesforce_account_rows: { label: "Accounts", expression: "count(*)" } },
    provenance: { source: "Salesforce Account", loadedAt: "2026-09-10T15:00:00Z", loadedBy: "casey@example.test", rows: 1204 } };
  expect(registerSchema.parse(body).metrics.salesforce_account_rows.label).toBe("Accounts");
  expect(registerSchema.safeParse({ ...body, dataset: "Bad-Name" }).success).toBe(false);
  expect(registerSchema.safeParse({ ...body, extra: true }).success).toBe(false);
  expect(registerSchema.safeParse({ ...body, metrics: { x: { label: "x", expression: "1", reviewed: true } } }).success).toBe(false);
  const reviewed = entry("salesforce_account", "published", { metrics: { salesforce_account_rows: { label: "Accounts", expression: "count(*)", reviewed: true, time_grains: ["month"], time_dimension: "salesforce_account.industry" } } });
  expect(metricIssues(reviewed)).toMatch(/time_grains requires a date time_dimension/);
  reviewed.metrics.salesforce_account_rows.time_dimension = "salesforce_account.created_date";
  expect(metricIssues(reviewed)).toBeNull();
  expect(metricIssues({ ...reviewed, table: { ...reviewed.table, default_date_column: "industry" } })).toMatch(/default_date_column/);
});

it("leaves a model without an overlay untouched", () => {
  const model: Model = { ...fixture };
  expect(mergeOverlay(model, { tables: {} }, "t")).toBe(model);
});
