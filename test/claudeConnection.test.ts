import { afterAll, beforeAll, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { claudeSetup, chatgptSetup } from "../src/mcp/connection.ts";

let root = "", url = "", output = "", app: ChildProcess;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "canvas-claude-"));
  const socket = createServer();
  await new Promise<void>(r => socket.listen(0, "127.0.0.1", r));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(r => socket.close(() => r()));
  url = `http://127.0.0.1:${port}`;
  await writeFile(join(root, "sources.yaml"), YAML.stringify({ sources: [{ id: "sample", label: "Sample Warehouse", adapter: "duckglue",
    model: resolve("sample-data/warehouse.yaml"), connector: { type: "duckdb", lakeRoot: resolve("sample-data/lake"), poolSize: 1 } }] }));
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

it("generates absolute, secret-free configuration for the actual API port", () => {
  const setup = claudeSetup(59231);
  expect(setup.code.command).toBe(process.execPath);
  expect(setup.code.args[1]).toMatch(/^file:/);
  expect(setup.code.args[2]).toBe(resolve("src/mcp/server.ts"));
  expect(setup.code.env).toEqual({ SEMANTIC_CANVAS_URL: "http://127.0.0.1:59231" });
  expect(setup.desktop.mcpServers["semantic-canvas"].args).toEqual(setup.code.args);
  expect(setup.command).toContain("claude mcp add-json --scope user semantic-canvas");
});

it("describes oversized JSON as a request limit rather than mislabelling every upload as a dashboard", async () => {
  const response = await fetch(url + "/api/setup/model", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "a".repeat(8 * 1024 * 1024) }) });
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ error: "Request body exceeds the 8 MB limit" });
});

it("checks a real MCP handshake and catalogue without creating a dashboard", async () => {
  const before = await (await fetch(url + "/api/dashboards")).json();
  const response = await fetch(url + "/api/setup/claude/check?source=sample", { method: "POST" });
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(200);
  expect(result).toMatchObject({ source: "sample", tools: 11 });
  expect(result.metrics).toBeGreaterThan(0);
  expect(await (await fetch(url + "/api/dashboards")).json()).toEqual(before);
  expect((await fetch(url + "/api/setup/claude/check?source=missing", { method: "POST" })).status).toBe(404);
  expect((await fetch(url + "/api/setup/claude/check", { method: "POST", headers: { Origin: "https://untrusted.example" } })).status).toBe(403);
}, 20_000);

it("adds evidence only on request, using exactly the finalized scoped rows and limit", async () => {
  const body = { metrics: ["new_signups"], dimensions: ["dim_users.country"], limit: 2 };
  const options = { method: "POST", headers: { "content-type": "application/json", "x-sc-source": "sample", "x-sc-principal": "emea" }, body: JSON.stringify(body) };
  const ordinary = await fetch(url + "/api/query", options), enriched = await fetch(url + "/api/query?evidence=1", options);
  expect(ordinary.status).toBe(200); expect(enriched.status).toBe(200);
  const plain = await ordinary.json(), withEvidence = await enriched.json();
  expect(plain).not.toHaveProperty("evidence");
  expect(withEvidence.rows).toEqual(plain.rows);
  expect(withEvidence.columns).toEqual(plain.columns);
  expect(withEvidence.sql).toBe(plain.sql);
  expect(withEvidence.rlsApplied).toEqual(plain.rlsApplied);
  expect(withEvidence.principal).toBe("emea");
  expect(withEvidence.truncated).toBe(true);
  expect(withEvidence.rows).toHaveLength(2);
  expect(withEvidence.evidence.rowsChecked).toBe(2);
  expect(withEvidence.evidence.observations).toEqual([]);
  expect(withEvidence.evidence.findings.map((f: any) => f.id)).toContain("limited");
  expect(withEvidence.evidence.observationNote).toContain("limited");
});

it("returns population definitions beside real movement totals without changing their values or scope", async () => {
  const request = { metrics: ["new_mrr", "net_new_mrr", "new_paying_customers"], dimensions: [] };
  const options = { method: "POST", headers: { "content-type": "application/json", "x-sc-source": "sample", "x-sc-principal": "admin" }, body: JSON.stringify(request) };
  const plainResponse = await fetch(url + "/api/query", options);
  const enrichedResponse = await fetch(url + "/api/query?evidence=1", options);
  expect(plainResponse.status).toBe(200); expect(enrichedResponse.status).toBe(200);
  const plain = await plainResponse.json(), enriched = await enrichedResponse.json();
  expect(enriched.rows).toEqual(plain.rows);
  expect(enriched.sql).toBe(plain.sql);
  expect(enriched.principal).toBe(plain.principal);
  const [newMrr, netNew, newCustomers] = enriched.evidence.metrics.map((m: any) => m.definition);
  expect(newMrr.expression).toContain("movement_type = 'new'");
  expect(newCustomers.expression).toContain("movement_type = 'new'");
  expect(netNew.expression).toBe("SUM(fct_mrr_movements.mrr_delta_usd)");
  expect(netNew.description).toContain("minus contraction and churn");
  expect(new Set([newMrr.baseTable, netNew.baseTable, newCustomers.baseTable]).size).toBe(1);
  expect(enriched.rows[0][0]).toBeCloseTo(186313.38, 2);
  expect(enriched.rows[0][1]).toBeCloseTo(202787.46, 2);
  expect(enriched.rows[0][2]).toBe(7851);
});

it("checks ChatGPT's scoped tools without claiming a remote connection or exposing another principal", async () => {
  const params = "source=sample&principal=emea&access=explore";
  const before = await (await fetch(url + "/api/dashboards")).json();
  const setup = await (await fetch(url + "/api/setup/chatgpt?" + params)).json();
  expect(setup.scope).toEqual({ source: "sample", principal: "emea", access: "explore" });
  expect(setup.entry.env).toEqual({ SEMANTIC_CANVAS_URL: url });
  expect(setup.mcpCommand).not.toContain("API_KEY");
  const response = await fetch(url + "/api/setup/chatgpt/check?" + params, { method: "POST" });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ tools: 8, source: "sample", principal: "emea", access: "explore" });
  expect(await (await fetch(url + "/api/dashboards")).json()).toEqual(before);
  expect((await fetch(url + "/api/setup/chatgpt?source=sample&principal=unknown")).status).toBe(400);
  expect((await fetch(url + "/api/setup/chatgpt/check?" + params, { method: "POST", headers: { Origin: "https://untrusted.example" } })).status).toBe(403);
}, 20_000);

for (const access of ["explore", "build"] as const) it(`ChatGPT ${access} mode enforces scope and write permissions over a real MCP connection`, async () => {
  const setup = chatgptSetup(Number(new URL(url).port), { source: "sample", principal: "emea", access });
  // Use the exact generated shell command, including paths with spaces, as the tunnel would.
  const transport = new StdioClientTransport({ command: "/bin/sh", args: ["-c", setup.mcpCommand], cwd: root, stderr: "pipe" });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "chatgpt-scope-test", version: "1" });
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const data = (result: any) => JSON.parse(result.content[0].text);
  try {
    await client.connect(transport);
    const listed = (await client.listTools()).tools;
    expect(listed).toHaveLength(access === "build" ? 10 : 8);
    expect(listed.map(t => t.name)).not.toContain("ask_user");
    expect(listed.find(t => t.name === "query_metric")?.annotations?.readOnlyHint).toBe(true);
    expect(data(await call("list_principals"))).toEqual({ active: "emea", principals: [{ id: "emea", name: "Bo (EMEA manager)" }] });
    expect(data(await call("list_sources")).sources.map((s: any) => s.id)).toEqual(["sample"]);
    expect((await call("describe_model", { source: "another" })).isError).toBe(true);
    expect((await call("query_metric", { metrics: ["new_signups"], principal: "admin" })).isError).toBe(true);
    const q = await call("query_metric", { metrics: ["new_signups"], dimensions: ["dim_users.country"] });
    expect(q.isError, JSON.stringify(q)).not.toBe(true);
    const countries = data(q).rows.map((r: unknown[]) => r[0]);
    expect(countries.length).toBeGreaterThan(0);
    expect(countries.every((c: string) => ["GB", "DE", "FR", "NL", "SE"].includes(c))).toBe(true);
    const evidence = data(q).evidence;
    expect(evidence.rowsChecked).toBe(countries.length);
    expect(evidence.metrics.map((m: any) => m.name)).toEqual(["new_signups"]);
    expect(evidence.metrics[0].definition).toMatchObject({ name: "new_signups", baseTable: "dim_users", type: "simple" });
    expect(evidence.observations[0].latest).toBe(Math.max(...data(q).rows.map((r: unknown[]) => Number(r[1]))));
    expect(evidence.observations[0].statement).not.toMatch(/US|CA|AU|BR|IN/);
    const id = "chatgpt-built", spec = { title: "Built from ChatGPT tools", tiles: [{ id: "new-users", title: "New users", metrics: ["new_signups"], dimensions: ["dim_users.country"], chart: "bar", layout: { x: 24, y: 24, w: 600, h: 360 } }] };
    if (access === "explore") {
      expect(listed.map(t => t.name)).not.toContain("save_dashboard");
      const result = await call("save_dashboard", { id, name: spec.title, spec, revision: 0 });
      expect(result.isError).toBe(true);
      expect((await fetch(url + "/api/dashboards/" + id + "?source=sample")).status).toBe(404);
    } else {
      expect(listed.find(t => t.name === "save_dashboard")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect((await call("save_dashboard", { id, name: spec.title, spec, revision: 0 })).isError).not.toBe(true);
      expect((await call("arrange_dashboard", { id, revision: 1, layout: "executive" })).isError).not.toBe(true);
      expect(data(await call("get_dashboard", { id })).revision).toBe(2);
      expect((await call("save_dashboard", { id, name: spec.title, spec, revision: 1 })).isError).toBe(true);
      const reopened = await (await fetch(url + "/api/dashboards/" + id + "?source=sample")).json();
      expect(reopened.spec.title).toBe(spec.title);
      expect(reopened.revision).toBe(2);
    }
  } finally { await client.close(); await transport.close(); }
}, 20_000);

it("refuses a missing principal instead of falling back to unrestricted local access", async () => {
  const setup = chatgptSetup(Number(new URL(url).port), { source: "sample", principal: "removed-principal", access: "explore" });
  const transport = new StdioClientTransport({ ...setup.entry, cwd: root, stderr: "pipe" });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "chatgpt-invalid-scope-test", version: "1" });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "query_metric", arguments: { metrics: ["new_signups"] } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("principal is no longer available");
  } finally { await client.close(); await transport.close(); }
});

it("uses the generated configuration from another directory to query, save, arrange and reopen a dashboard", async () => {
  const setup = await (await fetch(url + "/api/setup/claude")).json();
  const transport = new StdioClientTransport({ ...setup.code, cwd: root, stderr: "pipe" });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "canvas-integration-test", version: "1.0.0" });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return JSON.parse((result.content as { text: string }[])[0].text);
  };
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map(t => t.name)).toContain("save_dashboard");
    const sources = await call("list_sources", {});
    expect(sources.sources[0].id).toBe("sample");
    const model = await call("describe_model", { source: "sample" });
    expect(model.metrics.new_mrr).toBeTruthy();
    expect((await call("list_principals", {})).principals.map((p: { id: string }) => p.id)).toContain("admin");
    const query = await call("query_metric", { source: "sample", principal: "admin", metrics: ["new_mrr"], dimensions: ["month:movement_date"] });
    expect(query.rows.length).toBeGreaterThan(1);
    expect(query.evidence.timeDimensions).toEqual([{ dimension: "month:movement_date", resultColumn: "movement_date_month", grain: "month", dateMeaning: "Start of the month bucket, not its end." }]);
    expect(query.evidence.metrics[0]).toMatchObject({ name: "new_mrr", unit: "currency", unitSource: "declared" });
    expect(query.evidence.metrics[0].definition.expression).toContain("movement_type = 'new'");
    expect(query.evidence.observations[0].basis).toContain("month bucket starting");
    const invalid = await client.callTool({ name: "query_metric", arguments: { metrics: ["invented_metric"], source: "sample", principal: "admin" } });
    expect(invalid.isError).toBe(true);
    const spec = { title: "Created from Claude MCP", tiles: [{ id: "trend", title: "New MRR over time", chart: "line", metrics: ["new_mrr"],
      dimensions: ["month:movement_date"], layout: { x: 48, y: 48, w: 600, h: 360 } }] };
    await call("save_dashboard", { id: "claude-test", name: spec.title, source: "sample", spec, revision: 0 });
    const saved = await call("get_dashboard", { id: "claude-test", source: "sample" });
    expect(saved.spec.title).toBe(spec.title);
    expect(saved.revision).toBe(1);
    await call("arrange_dashboard", { id: "claude-test", source: "sample", revision: saved.revision, layout: "executive" });
    const reopened = await (await fetch(url + "/api/dashboards/claude-test?source=sample")).json();
    expect(reopened.revision).toBe(2);
    expect(reopened.spec.tiles[0].metrics).toEqual(["new_mrr"]);
    const stale = await client.callTool({ name: "save_dashboard", arguments: { id: "claude-test", source: "sample", spec, revision: 1 } });
    expect(stale.isError).toBe(true);
    expect((await call("get_dashboard", { id: "claude-test", source: "sample" })).revision).toBe(2);
  } finally { await client.close(); await transport.close(); }
}, 20_000);

it("keeps known zero starting MRR distinct from null retention in the real sample response", async () => {
  const response = await fetch(url + "/api/query?evidence=1", { method: "POST",
    headers: { "content-type": "application/json", "x-sc-source": "sample", "x-sc-principal": "admin" },
    body: JSON.stringify({ metrics: ["starting_mrr", "nrr"], dimensions: ["month:month"], limit: 36 }),
  });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.rows[0]).toEqual(["2024-09-01", 0, null]);
  expect(result.evidence.metrics[0].availability).toEqual({ columnPresent: true, numericValues: 24, zeroValues: 1, nullValues: 0, nonNumericValues: 0 });
  expect(result.evidence.metrics[1].availability).toEqual({ columnPresent: true, numericValues: 23, zeroValues: 0, nullValues: 1, nonNumericValues: 0 });
  expect(result.evidence.metrics[1].definition.expression).toContain("NULLIF");
});
