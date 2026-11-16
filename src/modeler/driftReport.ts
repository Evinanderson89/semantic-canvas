import { z } from "zod";
import type { DriftFinding } from "./extend.ts";

const name = z.string().min(1);
const common = { table: name, metrics: z.array(name), text: name };
const finding: z.ZodType<DriftFinding> = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("table_missing"), column: z.null(), declared: z.null(), actual: z.null() }),
  z.object({ ...common, kind: z.literal("column_missing"), column: name, declared: z.string(), actual: z.null() }),
  z.object({ ...common, kind: z.literal("type_changed"), column: name, declared: z.string(), actual: z.string() }),
]);

export const driftFindingsSchema = z.array(finding);

/** An absent findings array is unavailable evidence, never a clean check. */
export const driftReportSchema = z.object({
  source: name,
  checkedAt: z.string().datetime({ offset: true }),
  tables: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  drift: driftFindingsSchema,
  dashboards: z.array(z.object({
    id: name, name, metrics: z.array(name),
    charts: z.array(z.object({ id: name, title: z.string(), metrics: z.array(name).optional(), findings: z.array(name) })).optional(),
  })),
});
export type DriftReport = z.infer<typeof driftReportSchema>;
