import { expect, it } from "vitest";
import { driftReportSchema } from "../src/modeler/driftReport.ts";

const clean = { source: "sample", checkedAt: "2026-11-15T10:00:00Z", tables: 9, drift: [], dashboards: [] };
const missing = { table: "sales", column: "amount", kind: "column_missing", declared: "DOUBLE", actual: null, metrics: ["revenue"], text: "sales.amount is missing." };

it("accepts a complete clean check, including an empty catalogue, without inventing findings", () => {
  expect(driftReportSchema.parse(clean)).toEqual(clean);
  expect(driftReportSchema.parse({ ...clean, tables: 0 }).tables).toBe(0);
});

it("accepts all supported findings and preserves affected charts", () => {
  const report = { ...clean, drift: [missing,
    { ...missing, kind: "table_missing", column: null, declared: null },
    { ...missing, kind: "type_changed", actual: "VARCHAR" }],
    dashboards: [{ id: "exec", name: "Executive view", metrics: ["revenue"], charts: [{ id: "trend", title: "Revenue", metrics: ["revenue"], findings: ["sales.amount (column_missing)"] }] }] };
  expect(driftReportSchema.parse(report)).toEqual(report);
});

it.each(Object.keys(clean))("rejects a missing %s field instead of supplying a healthy default", field => {
  const incomplete: Record<string, unknown> = { ...clean }; delete incomplete[field];
  expect(driftReportSchema.safeParse(incomplete).success).toBe(false);
});

it.each([
  { drift: null }, { drift: {} }, { drift: [null] }, { drift: [{ ...missing, kind: "unknown" }] },
  { drift: [{ ...missing, metrics: null }] }, { drift: [{ ...missing, column: null }] },
  { dashboards: null }, { dashboards: [{ id: "exec", name: "Executive view", metrics: null }] },
  { dashboards: [{ id: "exec", name: "Executive view", metrics: [], charts: [null] }] },
  { checkedAt: "not a date" }, { checkedAt: "2026-11-15T10:00:00" },
  { tables: -1 }, { tables: 1.5 }, { tables: "9" }, { tables: Number.MAX_SAFE_INTEGER + 1 },
])("rejects malformed report evidence: %j", patch => {
  expect(driftReportSchema.safeParse({ ...clean, ...patch }).success).toBe(false);
});
