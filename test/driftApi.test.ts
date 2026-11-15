import { afterAll, beforeAll, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { driftReportSchema } from "../src/modeler/driftReport.ts";

let root = "", url = "", output = "", app: ChildProcess;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "canvas-drift-"));
  const socket = createServer();
  await new Promise<void>(r => socket.listen(0, "127.0.0.1", r));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(r => socket.close(() => r()));
  url = `http://127.0.0.1:${port}`;
  const model = YAML.parse(await readFile("sample-data/warehouse.yaml", "utf8"));
  model.tables.fct_mrr_movements.columns.push({ name: "retired_amount", type: "double" });
  model.tables.dim_users.columns.push({ name: "retired_country", type: "string" });
  model.metrics.retired_revenue = { label: "Retired revenue", base_table: "fct_mrr_movements", expression: "SUM(fct_mrr_movements.retired_amount)" };
  model.metrics.doubled_revenue = { label: "Doubled revenue", type: "derived", expression: "retired_revenue * 2" };
  await writeFile(join(root, "model.yaml"), YAML.stringify(model));
  await writeFile(join(root, "sources.yaml"), YAML.stringify({ sources: [{ id: "sample", label: "Sample Warehouse", adapter: "duckglue", model: join(root, "model.yaml"), connector: { type: "duckdb", lakeRoot: resolve("sample-data/lake"), poolSize: 1 } }] }));
  app = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { env: { ...process.env,
    PORT: String(port), SC_MODE: "local", SC_HOST: "127.0.0.1", SC_SERVE_UI: "false", SC_DATA_DIR: join(root, "data"),
    SOURCES_PATH: join(root, "sources.yaml"), SC_ENV_PATH: join(root, "absent.env"), RLS_PATH: resolve("security/policies.yaml"),
  }, stdio: ["ignore", "pipe", "pipe"] });
  app.stdout?.on("data", d => output += d); app.stderr?.on("data", d => output += d);
  for (let i = 0; i < 200; i++) {
    if (app.exitCode !== null) throw new Error(output);
    try { if ((await fetch(url + "/readyz")).ok) return; } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("Canvas did not start: " + output);
}, 30_000);
afterAll(async () => {
  if (app && app.exitCode === null) { app.kill("SIGTERM"); await new Promise(r => app.once("exit", r)); }
  if (root) await rm(root, { recursive: true, force: true });
});

it("reports computed and dimension-only dashboard impact from the real catalogue without changing documents", async () => {
  const tile = (id: string, metric: string, dimensions: string[] = []) => ({ id, title: id, metrics: [metric], dimensions, layout: { x: 20, y: 20, w: 400, h: 300 } });
  for (const [id, tiles] of [
    ["computed", [tile("derived-chart", "doubled_revenue")]],
    ["grouped", [tile("country-chart", "new_signups", ["dim_users.retired_country"])]],
    ["unaffected", [tile("total-signups", "new_signups")]],
  ] as const) {
    const saved = await fetch(url + "/api/dashboards", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, revision: 0, spec: { title: id, tiles } }) });
    expect(saved.status, await saved.text()).toBe(200);
  }
  const before = await (await fetch(url + "/api/dashboards")).json();
  const response = await fetch(url + "/api/modeler/drift?source=sample");
  const report = await response.json();
  expect(response.status, JSON.stringify(report)).toBe(200);
  expect(driftReportSchema.safeParse(report).success).toBe(true);
  expect(report.drift.find((f: any) => f.column === "retired_amount").metrics).toEqual(["doubled_revenue", "retired_revenue"]);
  expect(report.drift.find((f: any) => f.column === "retired_country").metrics).toEqual([]);
  expect(report.dashboards.map((d: any) => d.id).sort()).toEqual(["computed", "grouped"]);
  expect(report.dashboards.find((d: any) => d.id === "grouped").charts[0]).toMatchObject({ id: "country-chart", findings: ["dim_users.retired_country (column_missing)"] });
  expect(await (await fetch(url + "/api/dashboards")).json()).toEqual(before);
}, 20_000);
