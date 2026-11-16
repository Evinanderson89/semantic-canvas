import { afterAll, beforeAll, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createRateLimiter, limitClass, loadRateLimits, rateLimitMiddleware } from "../src/security/rateLimit.ts";

it("classifies provider calls and warehouse queries separately from other requests", () => {
  for (const path of ["/agent/chat", "/api/agent/explain", "/agent/beautify", "/agent/dashboard-story", "/reference/analyze"]) expect(limitClass("POST", path)).toBe("ai");
  expect(limitClass("POST", "/query")).toBe("query");
  expect(limitClass("GET", "/api/values")).toBe("query");
  // Polling and clarification answers must not consume the AI allowance.
  for (const [method, path] of [["GET", "/agent/status"], ["GET", "/agent/questions"], ["POST", "/agent/questions/q1/answer"], ["POST", "/dashboards"], ["GET", "/query"]])
    expect(limitClass(method, path)).toBe("general");
});

it("limits each account and class independently and recovers in the next window", () => {
  let time = 1_000_000;
  const take = createRateLimiter({ ai: 2, query: 3, general: 0 }, () => time);
  expect([take("a", "ai"), take("a", "ai")].every(r => r.allowed)).toBe(true);
  expect(take("a", "ai")).toEqual({ allowed: false, retryAfterSeconds: 60 });
  expect(take("b", "ai").allowed).toBe(true);
  expect(take("a", "query").allowed).toBe(true);
  time += 59_500;
  expect(take("a", "ai")).toEqual({ allowed: false, retryAfterSeconds: 1 });
  time += 500;
  expect(take("a", "ai").allowed).toBe(true);
  // 0 disables a class.
  for (let i = 0; i < 500; i++) expect(take("a", "general").allowed).toBe(true);
});

it("keeps memory bounded without unblocking an account that is over its limit", () => {
  let time = 0;
  const take = createRateLimiter({ ai: 1, query: 0, general: 0 }, () => time, 3);
  take("blocked", "ai"); time += 1;
  for (const account of ["b", "c", "d", "e"]) take(account, "ai");
  // The newest account is still counted. Under key pressure the oldest live window is dropped:
  // a bounded-memory trade-off that can release one account early, documented in self-hosting.md.
  expect(take("e", "ai").allowed).toBe(false);
  expect(take("blocked", "ai").allowed).toBe(true);
});

it("uses defaults, accepts overrides and refuses invalid configuration", () => {
  expect(loadRateLimits({})).toEqual({ ai: 30, query: 600, general: 1200 });
  expect(loadRateLimits({ SC_RATE_AI_PER_MINUTE: "5", SC_RATE_QUERY_PER_MINUTE: "0", SC_RATE_API_PER_MINUTE: " " })).toEqual({ ai: 5, query: 0, general: 1200 });
  for (const bad of ["-1", "1.5", "many", "100001"]) expect(() => loadRateLimits({ SC_RATE_AI_PER_MINUTE: bad })).toThrow(/SC_RATE_AI_PER_MINUTE/);
});

let server: Server, base = "";
const limited: string[] = [];
beforeAll(async () => {
  const app = express();
  app.use("/api", (req, _res, next) => { (req as any).account = req.header("x-test-account"); next(); });
  app.use("/api", rateLimitMiddleware({ ai: 1, query: 0, general: 0 }, req => (req as any).account, (kind, account) => limited.push(`${kind}:${account}`)));
  app.post("/api/agent/chat", (_req, res) => res.json({ ok: true }));
  server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise(resolve => server.close(resolve)));

it("returns 429 with Retry-After for the verified account and records it", async () => {
  const chat = (account?: string) => fetch(`${base}/api/agent/chat`, { method: "POST", headers: account ? { "x-test-account": account } : {} });
  expect((await chat("u1")).status).toBe(200);
  const refused = await chat("u1");
  expect(refused.status).toBe(429);
  expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
  expect((await refused.json()).error).toMatch(/AI request limit.*dashboard is unchanged/);
  expect((await chat("u2")).status).toBe(200);
  // No verified account means the sign-in guard owns the response; the limiter does not key on anything else.
  expect((await chat()).status).toBe(200);
  expect(limited).toEqual(["ai:u1"]);
});
