import { afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { duckglueAdapter } from "../src/semantic/duckglue.ts";
import { pooledDuckdb } from "../src/connectors/pool.ts";
import { compileTile } from "../src/compiler/compile.ts";
import { driftOf } from "../src/modeler/extend.ts";

const exec = promisify(execFile), roots: string[] = [];
const root = async () => { const dir = await mkdtemp(join(tmpdir(), "canvas messy cli '")); roots.push(dir); return dir; };
afterEach(async () => { await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const generate = (dir: string, date = "2026-09-13") => exec(process.execPath, ["--import", "tsx", resolve("scripts/messy-lake.ts"), dir, date]);

it("prints a usable source for a custom directory with a matching reporting calendar", async () => {
  const dir = await root(), { stdout } = await generate(dir, "2026-10-15");
  const [source] = YAML.parse(stdout.split("Add this entry under sources in sources.yaml:\n")[1]);
  expect(source.model).toBe(join(dir, "warehouse.yaml"));
  expect(source.connector.lakeRoot).toBe(join(dir, "lake"));
  const model = (await duckglueAdapter.load(source.model))!;
  expect(model.calendar?.today).toBe("2026-10-15");
  const conn = await pooledDuckdb(source.connector.lakeRoot, { size: 1 });
  try {
    const result = await conn.execute(compileTile(model, conn, { id: "orders", metrics: ["orders"], dimensions: [], layout: { x: 0, y: 0, w: 300, h: 200 } }));
    expect(Number(result.rows[0][0])).toBe(20000);
    // The intentionally stale revenue field must remain available for the drift walkthrough.
    expect(driftOf(model, await conn.catalog!())).toEqual([expect.objectContaining({ kind: "column_missing", column: "order_total", metrics: ["revenue"] })]);
  } finally { await conn.close(); }
});

it("preserves an existing authored model when regenerating fixture data", async () => {
  const dir = await root();
  const custom = (await readFile("sample-data/messy/warehouse.yaml", "utf8")) + "\n# User-authored model note.\n";
  await writeFile(join(dir, "warehouse.yaml"), custom);
  const { stdout } = await generate(dir);
  expect(await readFile(join(dir, "warehouse.yaml"), "utf8")).toBe(custom);
  expect(stdout).toContain("Existing model preserved");
});

it("does not replace data when an existing model has a different reporting date", async () => {
  const dir = await root(), table = join(dir, "lake", "fct_orders");
  await writeFile(join(dir, "warehouse.yaml"), await readFile("sample-data/messy/warehouse.yaml"));
  await mkdir(table, { recursive: true });
  await writeFile(join(table, "data.parquet"), "existing data must survive");
  await expect(generate(dir, "2026-10-15")).rejects.toThrow(/different reporting date/);
  expect(await readFile(join(table, "data.parquet"), "utf8")).toBe("existing data must survive");
});
