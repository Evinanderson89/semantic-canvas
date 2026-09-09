import { afterEach, expect, it, vi } from "vitest";
import express from "express";
import { createTelemetry, logRecord } from "../src/operations/telemetry.ts";
afterEach(() => vi.unstubAllEnvs());
it("allowlists operational fields without exposing payloads or credentials", () => {
  const record = logRecord("request.failed", { status: 500, requestId: "safe\nvalue", password: "secret", sql: "private", body: "private", cookie: "secret", rows: [{ secret: true }], errorType: "Error" });
  expect(record).toMatchObject({ requestId: "safe value", status: 500, errorType: "Error" });
  expect(JSON.stringify(record)).not.toMatch(/secret|private/);
});
it("exports real OTLP logs and traces with safe routes and request IDs", async () => {
  const received: { path: string; body: any }[] = [], lines: string[] = [];
  const collector = express(); collector.use(express.json({ limit: "2mb" }));
  collector.post("/v1/:signal", (q, r) => { received.push({ path: q.path, body: q.body }); r.json({}); });
  const collectorServer = collector.listen(0, "127.0.0.1"); await new Promise<void>(r => collectorServer.once("listening", r));
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", `http://127.0.0.1:${(collectorServer.address() as any).port}`);
  const telemetry = createTelemetry(process.env, line => lines.push(line));
  const app = express(); app.use(telemetry.middleware); app.post("/api/query", (_q, r) => r.json({ rows: [["PRIVATE RESULT"]] }));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/query?secret=DO-NOT-LOG`, { method: "POST", body: "PRIVATE BODY", headers: { cookie: "SECRET COOKIE" } });
    expect(response.headers.get("x-request-id")).toBeTruthy(); await response.text();
    await telemetry.close();
    expect(received.map(r => r.path).sort()).toEqual(["/v1/logs", "/v1/traces"]);
    const emitted = JSON.stringify(received); expect(emitted).toContain("/api/query"); expect(emitted).toContain(response.headers.get("x-request-id"));
    expect(emitted + lines.join("")).not.toMatch(/DO-NOT-LOG|PRIVATE|SECRET/);
    expect(telemetry.counters).toMatchObject({ requests: 1, queries: 1, failures: 0, inFlight: 0 });
  } finally { await telemetry.close(); await new Promise<void>(r => server.close(() => r())); await new Promise<void>(r => collectorServer.close(() => r())); }
});
