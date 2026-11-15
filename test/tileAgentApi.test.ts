import { afterAll, beforeAll, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";

let root: string, url: string, app: ChildProcess, output = "", hold = true;
const requests: ServerResponse[] = [];
const reply = (res: ServerResponse) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: "synthetic", type: "message", role: "assistant", model: "synthetic", content: [{ type: "text", text: "Synthetic completed answer." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })); };
const provider = createServer((req, res) => { req.resume(); requests.push(res); if (!hold) reply(res); });
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "canvas-agent-cancel-"));
  await new Promise<void>(r => provider.listen(0, "127.0.0.1", r));
  const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const probe = createServer(); await new Promise<void>(r => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port; await new Promise<void>(r => probe.close(() => r()));
  url = `http://127.0.0.1:${port}`;
  await writeFile(join(root, "sources.yaml"), YAML.stringify({ ai: { provider: "anthropic", model: "synthetic", apiKey: "synthetic-test-only" }, sources: [{ id: "sample", label: "Synthetic sample", adapter: "duckglue", model: resolve("sample-data/warehouse.yaml"), connector: { type: "duckdb", lakeRoot: resolve("sample-data/lake"), poolSize: 1 } }] }));
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
  for (const res of requests) if (!res.destroyed) res.destroy();
  if (app && app.exitCode === null) { app.kill("SIGTERM"); await new Promise(r => app.once("exit", r)); }
  provider.closeAllConnections(); await new Promise<void>(r => provider.close(() => r()));
  if (root) await rm(root, { recursive: true, force: true });
});
const body = JSON.stringify({ title: "Synthetic signups", metrics: ["new_signups"], dimensions: [], columns: ["new_signups"], rows: [[10]] });
for (const endpoint of ["explain", "beautify"]) it(`${endpoint}: browser disconnect closes the outstanding provider request, and a later request succeeds`, async () => {
  hold = true; const before = requests.length, controller = new AbortController();
  const pending = fetch(`${url}/api/agent/${endpoint}`, { method: "POST", signal: controller.signal, headers: { "content-type": "application/json" }, body }).catch(error => error);
  try {
    await expect.poll(() => requests.length, { timeout: 5000 }).toBe(before + 1);
    controller.abort(); await pending;
    await expect.poll(() => requests[before].destroyed, { timeout: 4000 }).toBe(true);
  } finally {
    controller.abort();
    if (requests[before] && !requests[before].destroyed) reply(requests[before]);
  }
  hold = false;
  const next = await fetch(`${url}/api/agent/${endpoint}`, { method: "POST", headers: { "content-type": "application/json" }, body });
  expect(next.ok).toBe(true);
  expect(await next.json()).toEqual({ text: "Synthetic completed answer." });
  expect((await fetch(url + "/readyz")).ok).toBe(true);
}, 15_000);
