import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { LoggerProvider, BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { SpanStatusCode } from "@opentelemetry/api";
import { identityOf } from "../security/auth.ts";

const allowed = new Set(["requestId", "actor", "role", "method", "route", "status", "durationMs", "source", "operation", "errorType", "mode", "readySources", "totalSources", "rows", "truncated", "revision", "count"]);
/** Allowlisting deliberately excludes request bodies, SQL, cookies, tokens, user names and file contents. */
export function logRecord(event: string, fields: Record<string, unknown> = {}, level = "info") {
  const safe = Object.fromEntries(Object.entries(fields).filter(([k, v]) => allowed.has(k) && ["string", "number", "boolean"].includes(typeof v)).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 256).replace(/[\r\n]/g, " ") : v]));
  return { time: new Date().toISOString(), level, service: "semantic-canvas", event, ...safe };
}
export function createTelemetry(env = process.env, write: (line: string) => void = line => process.stdout.write(`${line}\n`)) {
  const logsEnabled = Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT);
  const tracesEnabled = Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
  const enabled = logsEnabled || tracesEnabled;
  const resource = resourceFromAttributes({ "service.name": env.OTEL_SERVICE_NAME ?? "semantic-canvas", "service.version": "0.1.0" });
  const logs = logsEnabled ? new LoggerProvider({ resource, processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter(), maxQueueSize: 2048, exportTimeoutMillis: 5000 })] }) : undefined;
  const traces = tracesEnabled ? new NodeTracerProvider({ resource, spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter(), { maxQueueSize: 2048, exportTimeoutMillis: 5000 })] }) : undefined;
  const logger = logs?.getLogger("semantic-canvas"), tracer = traces?.getTracer("semantic-canvas");
  const counters = { requests: 0, failures: 0, queries: 0, queryFailures: 0, inFlight: 0 };
  const log = (event: string, fields: Record<string, unknown> = {}, level = "info") => {
    const record = logRecord(event, fields, level); write(JSON.stringify(record));
    logger?.emit({ body: event, severityText: level.toUpperCase(), severityNumber: level === "error" ? 17 : level === "warn" ? 13 : 9, attributes: record });
  };
  const middleware = (req: Request, res: Response, next: NextFunction) => {
    const id = randomUUID(), start = performance.now(); res.setHeader("x-request-id", id); res.locals.requestId = id;
    counters.requests++; counters.inFlight++;
    // The route template is known only after Express dispatch, never log originalUrl.
    const span = tracer?.startSpan("HTTP request");
    let finished = false;
    const finish = () => {
      if (finished) return; finished = true;
      const status = res.writableFinished ? res.statusCode : 499;
      const route = typeof req.route?.path === "string" ? String(req.route.path) : "unmatched";
      const durationMs = Math.round((performance.now() - start) * 100) / 100;
      counters.inFlight--; if (status >= 500) counters.failures++;
      if (route === "/api/query") { counters.queries++; if (status >= 400) counters.queryFailures++; }
      const identity = identityOf(req);
      const fields = { requestId: id, actor: identity?.id, role: identity?.role, method: req.method, route, status, durationMs };
      const mutation = !["GET", "HEAD", "OPTIONS"].includes(req.method) && /^\/api\/(dashboards|sources|agent\/key|operations)/.test(route);
      log(mutation ? "audit.change" : "http.request", fields, status >= 500 ? "error" : status >= 400 ? "warn" : "info");
      span?.updateName(`${req.method} ${route}`); span?.setAttributes({ "http.request.method": req.method, "http.route": route, "http.response.status_code": status, "sc.request_id": id });
      if (status >= 500) span?.setStatus({ code: SpanStatusCode.ERROR }); span?.end();
    };
    res.once("finish", finish); res.once("close", finish); next();
  };
  return { enabled, log, middleware, counters, async close() { await Promise.allSettled([logs?.shutdown(), traces?.shutdown()]); } };
}
