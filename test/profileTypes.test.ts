import { afterAll, beforeAll, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { DuckDBInstance } from "@duckdb/node-api";
import { pooledDuckdb } from "../src/connectors/pool.ts";
import { duckdbConnector } from "../src/connectors/duckdb.ts";
import { profileTables } from "../src/modeler/introspect.ts";
import { propose } from "../src/modeler/propose.ts";

let root = "", url = "", output = "", app: ChildProcess | undefined;
const columns = [{ name: "amount", type: "NUMBER(18,2)" }, { name: "tiny", type: "TINYINT" },
  { name: "unsigned", type: "UINTEGER" }, { name: "quantity", type: "INTEGER[]" }, { name: "label", type: "VARCHAR" },
  { name: "account_id", type: "BIGINT" }];
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "canvas-profile-types-"));
  await mkdir(join(root, "measurements"));
  const db = await DuckDBInstance.create(":memory:"), conn = await db.connect();
  try {
    await conn.run(`COPY (SELECT 10.25::DECIMAL(18,2) AS amount, 1::TINYINT AS tiny, 10::UINTEGER AS unsigned,
      [1,2]::INTEGER[] AS quantity, 'US' AS label, 9007199254740992::BIGINT AS account_id
      UNION ALL SELECT 20.50, 2, 20, [3,4], 'DE', 9007199254740993::BIGINT)
      TO '${join(root, "measurements", "part.parquet").replaceAll("'", "''")}' (FORMAT PARQUET)`);
  } finally { conn.closeSync(); db.closeSync(); }
  await writeFile(join(root, "model.yaml"), YAML.stringify({ name: "profile_types", tables: {
    measurements: { columns },
  }, metrics: { amount: { base_table: "measurements", expression: "SUM(measurements.amount)" } } }));
  await writeFile(join(root, "sources.yaml"), YAML.stringify({ sources: [{ id: "types", label: "Synthetic type evidence", adapter: "duckglue",
    model: join(root, "model.yaml"), connector: { type: "duckdb", lakeRoot: root, poolSize: 1 } }] }));
  await writeFile(join(root, "policies.yaml"), "principals: {}\npolicies: []\n");
  const socket = createServer();
  await new Promise<void>(r => socket.listen(0, "127.0.0.1", r));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(r => socket.close(() => r()));
  url = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { env: { ...process.env,
    PORT: String(port), SC_MODE: "local", SC_HOST: "127.0.0.1", SC_SERVE_UI: "false", SC_DATA_DIR: join(root, "data"),
    SOURCES_PATH: join(root, "sources.yaml"), SC_ENV_PATH: join(root, "absent.env"), RLS_PATH: join(root, "policies.yaml"),
  }, stdio: ["ignore", "pipe", "pipe"] });
  app.stdout?.on("data", d => output += d); app.stderr?.on("data", d => output += d);
  for (let i = 0; i < 200; i++) {
    if (app.exitCode !== null) throw new Error(output);
    try { if ((await fetch(url + "/readyz")).ok) return; } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("Synthetic Canvas server did not start: " + output);
}, 30_000);
afterAll(async () => {
  if (app && app.exitCode === null) { app.kill("SIGTERM"); await new Promise(r => app!.once("exit", r)); }
  if (root) await rm(root, { recursive: true, force: true });
});

it("profiles numeric warehouse metadata through the real API without treating arrays as scalar quantities", async () => {
  const response = await fetch(`${url}/api/profile?base=measurements&fields=${columns.map(c => c.name).join(",")}`);
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(body.fields.map((f: { field: string; role: string; cardinality: number }) => [f.field, f.role, f.cardinality])).toEqual([
    ["amount", "numeric", 2], ["tiny", "numeric", 2], ["unsigned", "numeric", 2], ["quantity", "categorical", 2], ["label", "geo", 2], ["account_id", "numeric", 2],
  ]);
  expect(body.fields[0].type).toBe("NUMBER(18,2)");
});

it("profiles repeated fields once so clients receive unambiguous evidence", async () => {
  const response = await fetch(`${url}/api/profile?base=measurements&fields=label,label,amount`);
  expect(response.status).toBe(200);
  expect((await response.json()).fields.map((f: { field: string }) => f.field)).toEqual(["label", "amount"]);
});

it("rejects excessive, malformed and unknown profile requests instead of silently dropping evidence", async () => {
  for (const query of [
    `base=measurements&fields=${Array.from({ length: 13 }, (_, i) => `field${i}`).join(",")}`,
    "base=measurements&fields=label&fields=amount",
    "base=measurements&fields=label,missing",
    "base=measurements&fields=label,,amount",
    "base=measurements&fields=",
    "base=measurements&base=other&fields=label",
  ]) {
    const response = await fetch(`${url}/api/profile?${query}`);
    expect(response.status, query).toBe(400);
    expect(await response.json()).toHaveProperty("error");
  }
});

it("returns a decimal aggregate as JSON instead of leaking a BigInt-backed wrapper", async () => {
  const response = await fetch(`${url}/api/query`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ metrics: ["amount"], dimensions: [] }) });
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(body.columns).toContain("amount");
  expect(body.rows[0][body.columns.indexOf("amount")]).toBe("30.75");
});

for (const [name, create] of [["pooled", () => pooledDuckdb(root, { size: 1 })], ["single", () => duckdbConnector(root)]] as const) {
  it(`${name} connector keeps neighboring large integers distinct and safe integers numeric`, async () => {
    const conn = await create();
    try {
      const result = await conn.execute(`SELECT 9007199254740991::BIGINT, 9007199254740992::BIGINT, 9007199254740993::BIGINT,
        -9007199254740993::BIGINT, 18446744073709551615::UBIGINT, 170141183460469231731687303715884105727::HUGEINT`);
      expect(JSON.parse(JSON.stringify(result)).rows[0]).toEqual([9007199254740991, "9007199254740992", "9007199254740993",
        "-9007199254740993", "18446744073709551615", "170141183460469231731687303715884105727"]);
    } finally { await conn.close(); }
  });
  it(`${name} connector serializes decimal scale, sign, null and high precision without rounding`, async () => {
    const conn = await create();
    try {
      const result = await conn.execute(`SELECT 10.25::DECIMAL(18,2), -0.01::DECIMAL(8,2), 0.00::DECIMAL(8,2),
        NULL::DECIMAL(8,2), '123456789012345678901234567890.12345678'::DECIMAL(38,8)`);
      expect(JSON.parse(JSON.stringify(result)).rows[0]).toEqual(["10.25", "-0.01", "0.00", null, "123456789012345678901234567890.12345678"]);
    } finally { await conn.close(); }
  });
}

it("returns distinct large identifiers and filters the exact selected account through the real API", async () => {
  const response = await fetch(`${url}/api/values?base=measurements&field=account_id`);
  const values = await response.json();
  expect(response.status, JSON.stringify(values)).toBe(200);
  expect(values.values).toEqual([{ value: "9007199254740992", n: 1 }, { value: "9007199254740993", n: 1 }]);
  for (const mode of ["discrete", "range"]) {
    const filter = mode === "discrete" ? { values: [values.values[1].value] } : { min: "9007199254740993", max: "9007199254740993" };
    const result = await fetch(`${url}/api/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      metrics: ["amount"], dimensions: ["account_id"], where: [{ id: "account", field: "account_id", source: "dimension", mode, ...filter }],
    }) });
    const body = await result.json();
    expect(result.status, JSON.stringify(body)).toBe(200);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0][body.columns.indexOf("account_id")]).toBe("9007199254740993");
    expect(body.rows[0][body.columns.indexOf("amount")]).toBe("20.50");
  }
});

it("retains numeric ranges and raw precision metadata without proposing SUM of a numeric array", async () => {
  const conn = await pooledDuckdb(root, { size: 1 });
  try {
    const tables = await profileTables(conn, [{ name: "measurements", columns }]);
    expect(tables[0].columns.find(c => c.name === "amount")).toMatchObject({ rawType: "NUMBER(18,2)", type: "double", min: "10.25", max: "20.50" });
    expect(tables[0].columns.find(c => c.name === "quantity")).toMatchObject({ type: "other", rawType: "INTEGER[]", min: null, max: null });
    const proposal = propose({ id: "types", label: "Types", tables, probes: [] });
    expect(proposal.metrics.some(m => m.expression === "SUM(measurements.amount)")).toBe(true);
    expect(proposal.metrics.some(m => /SUM\(measurements.quantity\)/.test(m.expression))).toBe(false);
  } finally { await conn.close(); }
});
