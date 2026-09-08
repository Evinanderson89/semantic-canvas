import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { openStore, closeStore, migrateLegacySources, loadDashboard, listDashboards } from "../src/store/store.ts";
it("migrates old store schemas without losing documents or guessing ambiguous source ownership", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sc-store-migration-"));
  const file = join(dir, "legacy.duckdb");
  const instance = await DuckDBInstance.create(file);
  const db = await instance.connect();
  await db.run("CREATE TABLE dashboards (id VARCHAR PRIMARY KEY, name VARCHAR NOT NULL, model VARCHAR NOT NULL, spec VARCHAR NOT NULL, canvas VARCHAR NOT NULL, updated_at TIMESTAMP NOT NULL)");
  await db.run("INSERT INTO dashboards VALUES ('old','Old','unique',?, '{}',now()), ('ambiguous','Ambiguous','shared',?, '{}',now())",
    [JSON.stringify({ title: "Old", tiles: [] }), JSON.stringify({ title: "Ambiguous", tiles: [] })]);
  db.closeSync(); instance.closeSync();
  try {
    await openStore(file);
    await migrateLegacySources([{ source: "one", model: "unique" }, { source: "two", model: "shared" }, { source: "three", model: "shared" }]);
    const restored = await loadDashboard("old", { source: "one", model: "unique" });
    expect(restored).toMatchObject({ revision: 1, spec: { title: "Old" }, canvas: { width: 1440 } });
    expect(await listDashboards({ source: "two", model: "shared" })).toEqual([]);
    expect(await listDashboards({ source: "three", model: "shared" })).toEqual([]);
  } finally { await closeStore(); await rm(dir, { recursive: true, force: true }); }
});
