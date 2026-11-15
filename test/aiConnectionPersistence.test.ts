import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";

// Only synthetic credentials and a loopback provider are used in this acceptance test.
let root: string, app: ChildProcess | undefined, url: string, providerUrl: string;
let inheritedKey = "", calls: { path: string; key: string }[] = [];
const provider = createServer((req, res) => {
  req.resume();
  const key = String(req.headers["x-api-key"] ?? "");
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  calls.push({ path, key });
  res.setHeader("content-type", "application/json");
  if (key === "synthetic-rejected") {
    res.statusCode = 401;
    res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "Synthetic credential rejected" } }));
  } else if (path.startsWith("/v1/models/")) {
    res.end(JSON.stringify({ id: decodeURIComponent(path.slice("/v1/models/".length)), type: "model", display_name: "Synthetic model", created_at: "2026-01-01T00:00:00Z" }));
  } else if (path === "/v1/messages") {
    res.end(JSON.stringify({ id: "synthetic", type: "message", role: "assistant", model: "synthetic", content: [{ type: "text", text: "Synthetic answer." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
  } else { res.statusCode = 404; res.end("{}"); }
});
const source = { id: "sample", label: "Sample", adapter: "duckglue", model: resolve("sample-data/warehouse.yaml"), connector: { type: "duckdb", lakeRoot: resolve("sample-data/lake"), poolSize: 1 } };
const headers = { "content-type": "application/json" };
const status = async () => (await fetch(url + "/api/agent/status")).json();
const save = (apiKey: string) => fetch(url + "/api/agent/key", { method: "POST", headers, body: JSON.stringify({ apiKey }) });
const explain = () => fetch(url + "/api/agent/explain", { method: "POST", headers, body: JSON.stringify({ title: "Synthetic signups", metrics: ["new_signups"], dimensions: [], columns: ["new_signups"], rows: [[10]] }) });
async function reloadSources() {
  const response = await fetch(url + "/api/sources/sample", { method: "PUT", headers, body: JSON.stringify(source) });
  expect(response.status).toBe(200);
}
async function stop() {
  const child = app; app = undefined;
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>(done => child.once("exit", () => done()));
    child.kill("SIGTERM"); await exited;
  }
}
async function start() {
  const probe = createServer(); await new Promise<void>(done => probe.listen(0, "127.0.0.1", done));
  const port = (probe.address() as { port: number }).port; await new Promise<void>(done => probe.close(() => done()));
  url = `http://127.0.0.1:${port}`;
  let output = "";
  app = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    env: { ...process.env, PORT: String(port), SC_HOST: "127.0.0.1", SC_MODE: "local", SC_SERVE_UI: "false",
      SC_DATA_DIR: join(root, "data"), SOURCES_PATH: join(root, "sources.yaml"), SC_ENV_PATH: join(root, ".env"),
      RLS_PATH: resolve("security/policies.yaml"), ANTHROPIC_BASE_URL: providerUrl, ANTHROPIC_API_KEY: inheritedKey },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout?.on("data", d => output += d); app.stderr?.on("data", d => output += d);
  for (let i = 0; i < 150; i++) {
    if (app.exitCode !== null) throw new Error(output);
    try { if ((await fetch(url + "/readyz")).ok) return; } catch { /* starting */ }
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error("Synthetic test API did not become ready");
}
beforeAll(async () => {
  await new Promise<void>(done => provider.listen(0, "127.0.0.1", done));
  providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "canvas-ai-persistence-")); inheritedKey = ""; calls = [];
  await writeFile(join(root, "sources.yaml"), YAML.stringify({ sources: [source] }));
  await writeFile(join(root, ".env"), "UNRELATED_SETTING=preserved\n", { mode: 0o600 });
});
afterEach(async () => { await stop(); if (root) await rm(root, { recursive: true, force: true }); });
afterAll(async () => { provider.closeAllConnections(); await new Promise<void>(done => provider.close(() => done())); });

it("a key added without an ai block survives source reload and process restart", async () => {
  await start(); expect((await status()).configured).toBe(false);
  expect((await save("synthetic-saved")).status).toBe(200);
  await reloadSources(); expect((await status()).configured).toBe(true);
  await stop(); await start(); expect((await status()).configured).toBe(true);
  expect((await explain()).status).toBe(200);
  expect(calls.at(-1)).toEqual({ path: "/v1/messages", key: "synthetic-saved" });
  expect(await readFile(join(root, "sources.yaml"), "utf8")).not.toContain("synthetic-saved");
  expect(await readFile(join(root, ".env"), "utf8")).toContain("UNRELATED_SETTING=preserved");
  expect((await stat(join(root, ".env"))).mode & 0o777).toBe(0o600);
}, 30_000);

it("replacement and removal persist over literal YAML credentials and inherited environment values", async () => {
  inheritedKey = "synthetic-inherited-old";
  await writeFile(join(root, ".env"), "ANTHROPIC_API_KEY=synthetic-file-old\nexport ANTHROPIC_API_KEY=synthetic-duplicate-old\nSC_AI_KEY_MANAGED=false\n");
  await writeFile(join(root, "sources.yaml"), YAML.stringify({ ai: { provider: "anthropic", model: "synthetic-model", apiKey: "synthetic-yaml-old" }, sources: [source] }));
  await start();
  expect((await save("synthetic-replacement")).status).toBe(200);
  await reloadSources(); expect((await explain()).status).toBe(200);
  expect(calls.at(-1)?.key).toBe("synthetic-replacement");
  await stop(); await start(); expect((await explain()).status).toBe(200);
  expect(calls.at(-1)?.key).toBe("synthetic-replacement");
  expect((await fetch(url + "/api/agent/key", { method: "DELETE" })).status).toBe(200);
  await reloadSources(); expect((await status()).configured).toBe(false);
  await stop(); await start(); expect((await status()).configured).toBe(false);
  const before = calls.length;
  expect((await explain()).status).toBe(503);
  expect(calls.length).toBe(before);
  expect(await readFile(join(root, ".env"), "utf8")).not.toContain("synthetic-replacement");
}, 30_000);

it("a rejected replacement leaves the saved credential and file intact", async () => {
  await start(); expect((await save("synthetic-valid")).status).toBe(200);
  const before = await readFile(join(root, ".env"), "utf8");
  expect((await save("synthetic-rejected")).status).toBe(422);
  expect(await readFile(join(root, ".env"), "utf8")).toBe(before);
  expect((await status()).configured).toBe(true);
  expect((await explain()).status).toBe(200);
  expect(calls.at(-1)?.key).toBe("synthetic-valid");
}, 30_000);

it.each([
  { reason: "unsupported provider", provider: "unsupported", model: "synthetic-model" },
  { reason: "missing model", provider: "anthropic", model: "  " },
])("$reason is reported consistently and blocks every AI route before external requests", async ({ provider: configuredProvider, model }) => {
  await writeFile(join(root, "sources.yaml"), YAML.stringify({ ai: { provider: configuredProvider, model, apiKey: "synthetic-configured" }, sources: [source] }));
  await start();
  const connection = await status();
  expect(connection.configured).toBe(false);
  expect(connection.canSetKey).toBe(false);
  expect(connection.issue).toContain("Anthropic");
  expect((await (await fetch(url + "/api/setup")).json()).checks.ai).toBe(false);
  const response = await save("synthetic-key");
  expect(response.status).toBe(422);
  expect((await response.json()).error).toContain("Anthropic");
  const syntheticTile = { title: "Synthetic", metrics: ["new_signups"], dimensions: [], columns: ["new_signups"], rows: [[10]] };
  for (const [path, body] of [
    ["/api/reference/analyze", { mime: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGZkAAAAASUVORK5CYII=" }],
    ["/api/agent/chat", { conversationId: "synthetic", message: "Explore the sample", mode: "chat" }],
    ["/api/agent/chat", { conversationId: "synthetic-redesign", message: "Improve the sample", mode: "redesign" }],
    ["/api/agent/explain", syntheticTile], ["/api/agent/beautify", syntheticTile],
    ["/api/agent/dashboard-story", { tiles: [{ ...syntheticTile, id: "synthetic", kind: "metric" }] }],
  ] as const) {
    const result = await fetch(url + path, { method: "POST", headers, body: JSON.stringify(body) });
    expect(result.status, path).toBe(503);
    expect((await result.json()).error, path).toBe(connection.issue);
  }
  expect(calls).toEqual([]);
  expect(await readFile(join(root, ".env"), "utf8")).toBe("UNRELATED_SETTING=preserved\n");
}, 30_000);
