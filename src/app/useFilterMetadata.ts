import { useEffect, useState } from "react";
import { z } from "zod";
import type { Model } from "../semantic/model.ts";
import type { FilterSpec } from "../compiler/spec.ts";
import { readResponse } from "./http.ts";

const value = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const valuesSchema = z.object({ values: z.array(z.object({ value,
  n: z.union([z.number(), z.string().regex(/^\d+$/)]).transform(Number).pipe(z.number().finite().int().nonnegative()),
})), truncated: z.boolean().optional() });
const extentSchema = z.object({ min: z.union([z.number().finite(), z.string(), z.null()]), max: z.union([z.number().finite(), z.string(), z.null()]) });
type Metadata = { kind: "values"; values: { value: string | number | boolean | null; n: number }[]; truncated: boolean }
  | { kind: "extent"; min: number | string | null; max: number | string | null };
export function filterMetadata(response: unknown, mode: FilterSpec["mode"]): Metadata {
  if (mode === "discrete") {
    const result = valuesSchema.safeParse(response);
    if (!result.success) throw new Error("The server returned invalid filter values. Try again.");
    return { kind: "values", ...result.data, truncated: result.data.truncated ?? false };
  }
  const result = extentSchema.safeParse(response);
  if (!result.success) throw new Error("The server returned an invalid data range. Try again.");
  return { kind: "extent", ...result.data };
}

/** Labels may coincide even when the underlying filter values differ. */
export function filterValueLabels(values: (string | number | boolean | null)[]): Map<string | number | boolean | null, string> {
  const unique = [...new Set(values)];
  const label = (v: (typeof unique)[number]) => v === null ? "Missing (null)" : typeof v === "string" && !v.trim() ? "Blank text" : String(v);
  const counts = new Map<string, number>();
  unique.forEach(v => counts.set(label(v), (counts.get(label(v)) ?? 0) + 1));
  const labels = new Map(unique.map(v => [v, counts.get(label(v))! > 1
    ? v === null ? "Missing (null)" : `${typeof v === "string" ? JSON.stringify(v) : String(v)} (${typeof v === "string" ? "text" : typeof v})`
    : label(v)]));
  // A literal category can itself look like one of the generated typed labels.
  // Quoting all text in that case gives every value an unambiguous identity.
  if (new Set(labels.values()).size !== labels.size) {
    for (const v of unique) if (typeof v === "string") labels.set(v, `${JSON.stringify(v)} (text)`);
  }
  return labels;
}

export function useFilterMetadata(model: Model, base: string, filter: FilterSpec, context: string, enabled = true) {
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([base, filter.field, filter.source, filter.mode, context, attempt, enabled]);
  const [state, setState] = useState<{ model: Model; key: string; data: Metadata | null; error: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const [base, field, source, mode] = JSON.parse(key) as [string, string, FilterSpec["source"], FilterSpec["mode"]];
    if (!enabled || source === "metric") return () => controller.abort();
    const finish = (data: Metadata | null, error = "") => {
      if (!controller.signal.aborted) setState({ model, key, data, error });
    };
    const params = new URLSearchParams({ base, field });
    fetch(`/api/${mode === "discrete" ? "values" : "extent"}?${params}`, { signal: controller.signal }).then(readResponse)
      .then(response => finish(filterMetadata(response, mode)))
      .catch(error => finish(null, error instanceof Error ? error.message : "Filter values could not be loaded."));
    return () => controller.abort();
  }, [model, key, enabled]);
  const current = state?.model === model && state.key === key ? state : null;
  return { data: current?.data ?? null, error: current?.error ?? "", retry: () => setAttempt(n => n + 1) };
}
