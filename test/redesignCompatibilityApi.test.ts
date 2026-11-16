import { afterAll, beforeAll, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";

let root: string, url: string, app: ChildProcess, output = "";
const seen: any[] = [];
const proposal = { title: "Readable headline", reason: "Put the headline first.", actions: [{ type: "place", id: "mrr", layout: { x: 24, y: 24, w: 500, h: 200 } }] };
// Local fake provider only: exercises SDK recovery AND the HTTP response contract.
const provider = createServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  seen.push(JSON.parse(body)); res.setHeader("content-type", "application/json");
  if (seen.length === 1) {
    res.statusCode = 400;
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "The compiled grammar is too large" } }));
    return;
  }
  const proposing = seen.length === 2;
  res.end(JSON.stringify({ id: "synthetic", type: "message", role: "assistant", model: "synthetic", content: proposing
    ? [{ type: "tool_use", id: "proposal", name: "propose_canvas_changes", input: proposal }]
    : [{ type: "text", text: "Ready for review." }], stop_reason: proposing ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
});
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "canvas-redesign-compatibility-"));
  await new Promise<void>(r => provider.listen(0, "127.0.0.1", r));
  const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const probe = createServer(); await new Promise<void>(r => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port; await new Promise<void>(r => probe.close(() => r()));
  url = `http://127.0.0.1:${port}`;
  await writeFile(join(root, "sources.yaml"), YAML.stringify({ defaultPrincipal: "admin", ai: { provider: "anthropic", model: "synthetic", apiKey: "synthetic-test-only" }, sources: [{ id: "sample", label: "Synthetic sample", adapter: "duckglue", model: resolve("sample-data/warehouse.yaml"), connector: { type: "duckdb", lakeRoot: resolve("sample-data/lake"), poolSize: 1 } }] }));
  app = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { env: { ...process.env, PORT: String(port), SC_HOST: "127.0.0.1", SC_MODE: "local", SC_SERVE_UI: "false", SC_DATA_DIR: join(root, "data"), SOURCES_PATH: join(root, "sources.yaml"), SC_ENV_PATH: join(root, "absent.env"), ANTHROPIC_BASE_URL: providerUrl, ANTHROPIC_API_KEY: "synthetic-test-only" }, stdio: ["ignore", "pipe", "pipe"] });
  app.stdout?.on("data", d => output += d); app.stderr?.on("data", d => output += d);
  for (let i = 0; i < 200; i++) {
    if (app.exitCode !== null) throw new Error(output);
    try { if ((await fetch(url + "/readyz")).ok) return; } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("Local test API did not start");
}, 30_000);
afterAll(async () => {
  if (app && app.exitCode === null) { app.kill("SIGTERM"); await new Promise(r => app.once("exit", r)); }
  provider.closeAllConnections(); await new Promise<void>(r => provider.close(() => r()));
  if (root) await rm(root, { recursive: true, force: true });
});
it("reports bounded schema recovery over HTTP without creating or saving a dashboard", async () => {
  const document = { spec: { title: "Synthetic draft", tiles: [{ id: "mrr", title: "Ending MRR", metrics: ["ending_mrr"], dimensions: ["month:fct_saas_monthly.month"], chart: "kpi", layout: { x: 200, y: 200, w: 300, h: 180 } }] }, canvas: DEFAULT_CANVAS, selected: [] };
  const response = await fetch(url + "/api/agent/chat", { method: "POST", headers: { "content-type": "application/json", "X-Source-Id": "sample", "X-Principal-Id": "admin" }, body: JSON.stringify({ conversationId: "synthetic-compatibility", mode: "redesign", message: "Make this headline readable.", document }) });
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(body.providerSchemaFallback).toBe(true);
  expect(body.proposal, JSON.stringify(seen.at(-1)?.messages)).toEqual(proposal);
  expect(seen[0].tools.some((t: any) => t.strict)).toBe(true);
  expect(seen.slice(1).every(r => r.tools.every((t: any) => !t.strict))).toBe(true);
  expect(seen.length).toBeLessThanOrEqual(3);
  expect((await (await fetch(url + "/api/dashboards")).json()).dashboards).toEqual([]);
}, 15_000);
