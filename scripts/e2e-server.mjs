import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import YAML from "yaml";

// Browser acceptance must not inherit a developer's warehouse, provider key or company session configuration.
const directory = await mkdtemp(join(tmpdir(), "canvas-e2e-server-"));
try {
  const sources = join(directory, "sources.yaml"), environment = join(directory, "empty.env");
  await writeFile(environment, "# Intentionally no provider credentials.\n");
  await writeFile(sources, YAML.stringify({ defaultPrincipal: "admin", sources: [{
    id: "duckglue-local", label: "Sample Warehouse", adapter: "duckglue", model: resolve("sample-data/warehouse.yaml"),
    connector: { type: "duckdb", lakeRoot: resolve("sample-data/lake"), poolSize: 4 },
  }] }));
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    env: { ...process.env, SC_MODE: "local", SC_HOST: "127.0.0.1", SC_SERVE_UI: "false", SOURCES_PATH: sources,
      SC_ENV_PATH: environment, RLS_PATH: resolve("security/policies.yaml"), ANTHROPIC_API_KEY: "" }, stdio: "inherit",
  });
  const stop = () => child.kill("SIGTERM");
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  process.exitCode = await new Promise((resolve, reject) => { child.once("exit", code => resolve(code ?? 0)); child.once("error", reject); });
  process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop);
} finally { await rm(directory, { recursive: true, force: true }); }
