import { useEffect, useState } from "react";
import { z } from "zod";
import type { Model } from "../semantic/model.ts";
import type { FieldProfile } from "../suggest/recommend.ts";
import { readResponse } from "./http.ts";

const responseSchema = z.object({ fields: z.array(z.object({
  field: z.string(), type: z.string(), cardinality: z.number().finite().nonnegative().nullable(),
  sample: z.array(z.string()), role: z.enum(["temporal", "geo", "categorical", "numeric"]), isoLike: z.boolean().optional(),
  warning: z.string().optional(),
})) });

/** Match field identity, never response order: an omitted field is not a zero-dimensional chart. */
export function dimensionProfiles(response: unknown, dimensions: string[]): FieldProfile[] {
  const parsed = responseSchema.safeParse(response);
  if (!parsed.success) throw new Error("The server returned invalid field profiles. Try again.");
  return dimensions.map(dimension => {
    const temporal = dimension.includes(":"), field = temporal ? dimension.slice(dimension.indexOf(":") + 1) : dimension;
    const matches = parsed.data.fields.filter(p => p.field === field);
    if (matches.length !== 1) throw new Error(`The profile for ${field} is missing or ambiguous. Refresh the data or check the metric definition.`);
    return temporal ? { ...matches[0], role: "temporal" } : matches[0];
  });
}

export function useFieldProfiles(model: Model, base: string | null | undefined, dimensions: string[], context: string, enabled = true) {
  const key = JSON.stringify([base, dimensions, context]);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ model: Model; key: string; attempt: number; profiles: FieldProfile[] | null; error: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    if (!enabled) return () => controller.abort();
    const [base, dimensions] = JSON.parse(key) as [string | null, string[]];
    if (!dimensions.length) return () => controller.abort();
    const finish = (profiles: FieldProfile[] | null, error = "") => {
      if (!controller.signal.aborted) setState({ model, key, attempt, profiles, error });
    };
    if (!base) { finish(null, "Choose a metric with a valid base table to see visualization suggestions."); return () => controller.abort(); }
    const fields = dimensions.map(d => d.includes(":") ? d.slice(d.indexOf(":") + 1) : d);
    const params = new URLSearchParams({ base, fields: [...new Set(fields)].join(",") });
    fetch(`/api/profile?${params}`, { signal: controller.signal }).then(readResponse)
      .then(response => finish(dimensionProfiles(response, dimensions)))
      .catch(error => finish(null, error instanceof Error ? error.message : "Field profiling failed. Try again."));
    return () => controller.abort();
  }, [model, key, attempt, enabled]);
  // Invalidate during render as well as on effect cleanup, so old actions cannot flash between requests.
  const current = state?.model === model && state.key === key && state.attempt === attempt ? state : null;
  return { profiles: !enabled ? null : dimensions.length ? current?.profiles ?? null : [], error: enabled && dimensions.length ? current?.error ?? "" : "",
    retry: () => setAttempt(n => n + 1) };
}
