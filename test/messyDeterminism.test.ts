import { afterEach, expect, it, vi } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMessyLake } from "../src/testing/messyLake.ts";

const create = DuckDBInstance.create.bind(DuckDBInstance);
const roots: string[] = [];
const root = async () => { const dir = await mkdtemp(join(tmpdir(), "canvas-messy-repeat-")); roots.push(dir); return dir; };
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function fingerprint(dir: string, tables: string[]) {
  const db = await create(":memory:"), c = await db.connect();
  try {
    const result: Record<string, string> = {};
    for (const table of tables) {
      const path = join(dir, "lake", table, "data.parquet").replace(/'/g, "''");
      const rows = await c.runAndReadAll(`SELECT to_json(t)::VARCHAR AS serialized FROM read_parquet('${path}') t ORDER BY serialized`);
      // Compare logical rows, not Parquet metadata or physical row ordering.
      const hash = createHash("sha256");
      for (const [row] of rows.getRows()) hash.update(`${row}\n`);
      result[table] = hash.digest("hex");
    }
    result.csv = createHash("sha256").update(await readFile(join(dir, "messy-orders.csv"))).digest("hex");
    return result;
  } finally { c.closeSync(); db.closeSync(); }
}

it("repeats every table value and the ingest CSV across one and four DuckDB workers", async () => {
  const first = await root(), second = await root();
  const factory = vi.spyOn(DuckDBInstance, "create");
  factory.mockImplementationOnce((path, options) => create(path, { ...options, threads: "1" }));
  const a = await writeMessyLake(first);
  factory.mockImplementationOnce((path, options) => create(path, { ...options, threads: "4" }));
  const b = await writeMessyLake(second);
  expect(b.tables).toEqual(a.tables);
  expect(await fingerprint(second, Object.keys(b.tables))).toEqual(await fingerprint(first, Object.keys(a.tables)));
}, 30_000);

it("closes both DuckDB handles when writing the generated files fails", async () => {
  const dir = await root(); await mkdir(join(dir, "README.md"));
  const db = await create(":memory:"), c = await db.connect();
  const closeConnection = vi.spyOn(c, "closeSync"), closeDatabase = vi.spyOn(db, "closeSync");
  vi.spyOn(DuckDBInstance, "create").mockResolvedValueOnce(db);
  vi.spyOn(db, "connect").mockResolvedValueOnce(c);
  try {
    await expect(writeMessyLake(dir)).rejects.toThrow(/EISDIR/);
    expect(closeConnection).toHaveBeenCalledTimes(1);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
  } finally {
    if (!closeConnection.mock.calls.length) c.closeSync();
    if (!closeDatabase.mock.calls.length) db.closeSync();
  }
});

it("closes the database when connecting fails", async () => {
  const db = await create(":memory:");
  const close = vi.spyOn(db, "closeSync");
  vi.spyOn(DuckDBInstance, "create").mockResolvedValueOnce(db);
  vi.spyOn(db, "connect").mockRejectedValueOnce(new Error("connection unavailable"));
  try {
    await expect(writeMessyLake(await root())).rejects.toThrow("connection unavailable");
    expect(close).toHaveBeenCalledTimes(1);
  } finally { if (!close.mock.calls.length) db.closeSync(); }
});
