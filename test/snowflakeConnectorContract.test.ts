import { afterEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
const driver = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], sql: [] as string[] }));
vi.mock("snowflake-sdk", () => ({ default: { createConnection: () => ({
  connect(done: (error: null) => void) { done(null); },
  execute(options: any) { driver.sql.push(options.sqlText); options.complete(null, {}, driver.rows); },
  destroy(done: (error: null) => void) { done(null); },
}) } }));
import { snowflakeConnector } from "../src/connectors/snowflake.ts";
import { snowflakeSemanticAdapter } from "../src/semantic/snowflakeSemantic.ts";
import { compileTile } from "../src/compiler/compile.ts";
import { tile } from "./fixtures.ts";

// Use the installed SDK's actual value object; only network/connection I/O is mocked.
const SfTimestamp = createRequire(import.meta.url)("snowflake-sdk/dist/lib/connection/result/sf_timestamp.js");
const open = (database = "DEFAULT_DB", schema = "DEFAULT_SCHEMA") => snowflakeConnector({
  account: "synthetic", username: "synthetic", warehouse: "synthetic", database, schema, poolSize: 1,
});
afterEach(() => { driver.rows = []; driver.sql = []; });

it("preserves distinct intraday instants, UTC offsets and SDK fractional precision in query JSON", async () => {
  const seconds = Date.parse("2026-08-01T09:30:00Z") / 1000;
  driver.rows = [
    { at: new Date("2026-08-01T09:30:00.123Z"), value: 10 },
    { at: new Date("2026-08-01T15:45:00-04:00"), value: 20 },
    { at: new SfTimestamp(seconds, 123456789, 9, "America/New_York", "YYYY-MM-DD HH24:MI:SS.FF9 TZH:TZM").toSfDate(), value: 30 },
    { at: new SfTimestamp(-1, 999999999, 9, "UTC", "YYYY-MM-DD HH24:MI:SS.FF9").toSfDate(), value: 40 },
    { at: new Date("2026-08-01T00:00:00Z"), value: 50 },
    { at: null, value: 60 },
  ];
  const conn = await open();
  try {
    const result = JSON.parse(JSON.stringify(await conn.execute("SELECT synthetic_timestamps")));
    expect(result.rows).toEqual([
      ["2026-08-01T09:30:00.123Z", 10], ["2026-08-01T19:45:00.000Z", 20],
      ["2026-08-01T09:30:00.123456789Z", 30], ["1969-12-31T23:59:59.999999999Z", 40],
      ["2026-08-01T00:00:00.000Z", 50], [null, 60],
    ]);
  } finally { await conn.close(); }
});

it("compiles imported cross-schema joins through the real connector rather than its configured defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvas-snowflake-relations-"));
  const conn = await open();
  try {
    const path = join(directory, "model.yaml");
    await writeFile(path, YAML.stringify({ name: "Revenue", tables: [
      { name: "orders", base_table: { database: "FINANCE", schema: "MARTS", table: "ORDERS" },
        dimensions: [{ name: "user_id", expr: "user_id", data_type: "NUMBER" }],
        facts: [{ name: "amount", expr: "amount", data_type: "NUMBER" }],
        metrics: [{ name: "revenue", expr: "SUM(amount)" }] },
      { name: "users", base_table: { database: "CRM", schema: "CUSTOMERS", table: "USERS" },
        dimensions: [{ name: "user_id", expr: "user_id", data_type: "NUMBER" }, { name: "country", expr: "country", data_type: "VARCHAR" }] },
    ], relationships: [{ name: "owner", left_table: "orders", right_table: "users",
      relationship_columns: [{ left_column: "user_id", right_column: "user_id" }] }] }));
    const model = await snowflakeSemanticAdapter.load(path);
    if (!model) throw new Error("Synthetic model did not load");
    const sql = compileTile(model, conn, tile({ metrics: ["revenue"], dimensions: ["USERS.country"] }));
    expect(sql).toContain('FROM "FINANCE"."MARTS"."ORDERS" AS ORDERS');
    expect(sql).toContain('LEFT JOIN "CRM"."CUSTOMERS"."USERS" AS USERS');
    expect(sql).not.toContain("DEFAULT_DB");
    expect(sql).not.toContain("DEFAULT_SCHEMA");
    await conn.execute(sql);
    expect(driver.sql).toEqual([sql]);
  } finally { await conn.close(); await rm(directory, { recursive: true, force: true }); }
});

it("quotes each relation component independently and defaults only absent physical qualifiers", async () => {
  const conn = await open('Default"DB', "Default Schema");
  try {
    expect(conn.relation("ORDERS")).toBe('"Default""DB"."Default Schema"."ORDERS"');
    expect(conn.relation("logical", { database: "Other.DB", schema: 'Mart"s', table: 'Order"Lines' }))
      .toBe('"Other.DB"."Mart""s"."Order""Lines"');
    expect(conn.relation("logical", { table: "Physical" })).toBe('"Default""DB"."Default Schema"."Physical"');
  } finally { await conn.close(); }
});

it("uses the same identifier quoting for schema discovery and preserves schema literal escaping", async () => {
  const conn = await open('Finance"Archive', "Owner's schema");
  try {
    driver.rows = [{ TABLE_NAME: "ORDERS", COLUMN_NAME: "AMOUNT", DATA_TYPE: "NUMBER", ORDINAL_POSITION: 1 }];
    expect(await conn.schema()).toEqual([{ name: "ORDERS", columns: [{ name: "AMOUNT", type: "number" }] }]);
    expect(driver.sql[0]).toContain('FROM "Finance""Archive".INFORMATION_SCHEMA.COLUMNS');
    expect(driver.sql[0]).toContain("TABLE_SCHEMA = 'Owner''s schema'");
  } finally { await conn.close(); }
});

it("uses the session database for discovery when no database is configured", async () => {
  const conn = await open("");
  try {
    await conn.schema();
    expect(driver.sql[0]).toContain("FROM INFORMATION_SCHEMA.COLUMNS");
    expect(driver.sql[0]).not.toContain('"".INFORMATION_SCHEMA');
  } finally { await conn.close(); }
});
