import { joinProblems } from "../compiler/issueText.ts";
import { createHash } from "node:crypto";
import { numericValue } from "../charts/values.ts";
import { compileTile, parseDimension, splitPartialPeriods, validateTile } from "../compiler/compile.ts";
import { coverageWarnings, finishResult } from "../compiler/result.ts";
import type { DashboardSpec, TileSpec } from "../compiler/spec.ts";
import type { Connector } from "../connectors/types.ts";
import { makeFormatter, metricUnit, resolveFormat } from "../format/format.ts";
import { isUnreviewed, metricOf, todayOf, type Model } from "../semantic/model.ts";
import { reviewDataHonesty } from "./dataHonesty.ts";

export interface DigestOptions {
  role?: "viewer" | "editor" | "admin";
  principal?: string | null;
}

export interface DigestKpi {
  tileId: string;
  title: string;
  metric: string;
  label: string;
  unit: string;
  headlineValue: number | null;
  value: number | null;
  formattedValue: string;
  priorValue: number | null;
  delta: number | null;
  percentChange: number | null;
  period: string | null;
  priorPeriod: string | null;
}

export interface ExecutiveDigest {
  title: string;
  generatedAt: string;
  principal: string | null;
  kpis: DigestKpi[];
  headlineBullets: string[];
  caveats: string[];
  provenanceHash: string;
}

export interface VerifiedBriefBundle {
  version: 1;
  title: string;
  generatedAt: string;
  digest: ExecutiveDigest;
  specSummary: { tiles: number };
  signatureHash: string;
}

function normalizeDate(value: unknown): string {
  if (value instanceof Date && Number.isFinite(+value)) {
    return value.toISOString().slice(0, 10);
  }
  return String(value ?? "").slice(0, 10);
}

function formatMetricValue(model: Model, tile: TileSpec, metricName: string, value: number | null): string {
  if (value === null) return "N/A";
  const singleTile: TileSpec = { ...tile, metrics: [metricName] };
  const formatter = makeFormatter(resolveFormat(model, singleTile));
  return formatter(value);
}

function formatDeltaSummary(
  model: Model,
  tile: TileSpec,
  metricName: string,
  delta: number,
  percentChange: number | null,
): string {
  const unit = metricUnit(model, metricName);
  const sign = delta > 0 ? "+" : "";
  if (unit === "percent") {
    const pts = (delta * 100).toFixed(1);
    return `${sign}${pts} pp`;
  }
  const formattedDelta = formatMetricValue(model, tile, metricName, delta);
  const withSign = delta > 0 && !formattedDelta.startsWith("+") ? `+${formattedDelta}` : formattedDelta;
  if (percentChange !== null) {
    const pct = (percentChange * 100).toFixed(1);
    return `${withSign} (${sign}${pct}%)`;
  }
  return withSign;
}

function computeProvenanceHash(input: {
  modelName: string;
  title: string;
  principal: string | null;
  kpis: DigestKpi[];
  caveats: string[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        modelName: input.modelName,
        title: input.title,
        principal: input.principal,
        kpis: input.kpis.map((k) => ({
          tileId: k.tileId,
          metric: k.metric,
          headlineValue: k.headlineValue,
          priorValue: k.priorValue,
          delta: k.delta,
          period: k.period,
          priorPeriod: k.priorPeriod,
        })),
        caveats: input.caveats,
      }),
    )
    .digest("hex");
}

/**
 * Evaluates metric tiles on a DashboardSpec, computing each tile's headline value,
 * comparison delta (when a time axis exists), and active data-honesty caveats.
 */
export async function generateExecutiveDigest(
  model: Model,
  conn: Connector,
  spec: DashboardSpec,
  options?: DigestOptions,
): Promise<ExecutiveDigest> {
  const generatedAt = new Date().toISOString();
  const principal = options?.principal ?? null;
  const kpis: DigestKpi[] = [];
  const headlineBullets: string[] = [];
  const caveats: string[] = [];
  const seenCaveats = new Set<string>();
  const addCaveat = (text: string) => {
    if (!seenCaveats.has(text)) {
      seenCaveats.add(text);
      caveats.push(text);
    }
  };

  const metricTiles = spec.tiles.filter(
    (t) => (!t.kind || t.kind === "metric") && Array.isArray(t.metrics) && t.metrics.length > 0,
  );

  for (const tile of metricTiles) {
    const tileTitle =
      tile.title ??
      tile.metrics.map((m) => metricOf(model, m)?.label ?? m).join(", ");

    for (const mName of tile.metrics) {
      const m = metricOf(model, mName);
      if (m && isUnreviewed(model, m)) {
        addCaveat(
          `${tileTitle}: Metric "${m.label}" (${m.name}) is unreviewed (draft metric or backed by an unreviewed table).`,
        );
      }
    }

    const validationIssues = validateTile(model, tile, { role: options?.role });
    if (validationIssues.length > 0) {
      addCaveat(
        `${tileTitle}: Skipped (${joinProblems(validationIssues.map((i) => i.problem)).replace(/\.$/, "")}).`,
      );
      continue;
    }

    const sql = compileTile(model, conn, tile, { probe: true, role: options?.role });
    const rawResult = await conn.execute(sql);
    const finished = finishResult(rawResult, tile);
    const { columns, rows, partial } = splitPartialPeriods(finished);

    if (partial.start || partial.end) {
      const which =
        partial.start && partial.end
          ? "start and end"
          : partial.start
            ? "start"
            : "end";
      addCaveat(
        `${tileTitle}: Partial ${which} edge period excluded so incomplete buckets are not compared against full periods.`,
      );
    }

    for (const warning of coverageWarnings(partial)) {
      addCaveat(`${tileTitle}: ${warning}`);
    }

    if (finished.truncated) {
      addCaveat(
        `${tileTitle}: Result was truncated at the ${finished.limit}-row limit; headline reflects visible rows only.`,
      );
    }

    const timeDim = (tile.dimensions ?? []).find((d) => d.includes(":"));
    if (timeDim) {
      const honestyFindings = reviewDataHonesty({
        tile: {
          ...tile,
          compare: tile.compare && tile.compare !== "none" ? tile.compare : "prior",
        },
        model,
        columns,
        rows,
        partial,
        timeDimension: timeDim,
        where: tile.where,
        today: todayOf(model),
      });
      for (const finding of honestyFindings) {
        addCaveat(`${tileTitle}: ${finding.text}`);
      }
    }

    const primaryMetric = metricOf(model, tile.metrics[0]);
    const baseTable = primaryMetric ? model.tables[primaryMetric.baseTable] : undefined;
    if (baseTable?.reportingLagDays && baseTable.reportingLagDays > 0) {
      const hasLagCaveat = caveats.some(
        (c) => c.startsWith(`${tileTitle}:`) && c.includes("settles after"),
      );
      if (!hasLagCaveat) {
        addCaveat(
          `${tileTitle}: Source table ${baseTable.name} has a ${baseTable.reportingLagDays}-day reporting lag.`,
        );
      }
    }

    for (const metricName of tile.metrics) {
      const metric = metricOf(model, metricName);
      if (!metric) continue;
      const metricIdx = columns.indexOf(metricName);
      if (metricIdx < 0) continue;

      let headlineValue: number | null = null;
      let priorValue: number | null = null;
      let delta: number | null = null;
      let percentChange: number | null = null;
      let period: string | null = null;
      let priorPeriod: string | null = null;

      if (timeDim) {
        const parsedTime = parseDimension(timeDim);
        const timeAlias = parsedTime.grain
          ? `${parsedTime.column}_${parsedTime.grain}`
          : parsedTime.column;
        const timeIdx = columns.indexOf(timeAlias);
        const prevIdx = columns.indexOf(`${metricName}__prev`);

        if (timeIdx >= 0 && rows.length > 0) {
          // Aggregate by period if there are additional categorical breakdowns, or read directly for single series
          const hasCatDims = (tile.dimensions ?? []).length > 1;
          if (!hasCatDims) {
            const datedRows = rows
              .map((row) => ({
                period: normalizeDate(row[timeIdx]),
                value: numericValue(row[metricIdx]),
                prev: prevIdx >= 0 ? numericValue(row[prevIdx]) : null,
              }))
              .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.period) && r.value !== null)
              .sort((a, b) => a.period.localeCompare(b.period));

            if (datedRows.length > 0) {
              const latest = datedRows.at(-1)!;
              headlineValue = latest.value;
              period = latest.period;
              if (latest.prev !== null) {
                priorValue = latest.prev;
              } else if (datedRows.length >= 2) {
                const prior = datedRows.at(-2)!;
                priorValue = prior.value;
                priorPeriod = prior.period;
              }
            }
          } else {
            const byPeriod = new Map<string, number>();
            for (const row of rows) {
              const p = normalizeDate(row[timeIdx]);
              const v = numericValue(row[metricIdx]);
              if (!/^\d{4}-\d{2}-\d{2}$/.test(p) || v === null) continue;
              byPeriod.set(p, (byPeriod.get(p) ?? 0) + v);
            }
            const sortedPeriods = [...byPeriod.entries()].sort((a, b) =>
              a[0].localeCompare(b[0]),
            );
            if (sortedPeriods.length > 0) {
              const latest = sortedPeriods.at(-1)!;
              period = latest[0];
              headlineValue = latest[1];
              if (sortedPeriods.length >= 2) {
                const prior = sortedPeriods.at(-2)!;
                priorPeriod = prior[0];
                priorValue = prior[1];
              }
            }
          }
        }
      } else if ((tile.dimensions ?? []).length === 0) {
        if (rows.length > 0) {
          headlineValue = numericValue(rows[0][metricIdx]);
        }
      } else {
        const numericRows = rows
          .map((row) => numericValue(row[metricIdx]))
          .filter((v): v is number => v !== null);
        if (numericRows.length > 0) {
          headlineValue = Math.max(...numericRows);
        }
      }

      if (headlineValue !== null && priorValue !== null) {
        delta = headlineValue - priorValue;
        percentChange = priorValue === 0 ? null : delta / Math.abs(priorValue);
      }

      const formattedValue = formatMetricValue(model, tile, metricName, headlineValue);
      const kpi: DigestKpi = {
        tileId: tile.id,
        title: tileTitle,
        metric: metric.name,
        label: metric.label,
        unit: metricUnit(model, metric.name),
        headlineValue,
        value: headlineValue,
        formattedValue,
        priorValue,
        delta,
        percentChange,
        period,
        priorPeriod,
      };
      kpis.push(kpi);

      if (headlineValue !== null) {
        const periodLabel = period ? ` (${period})` : "";
        const deltaText =
          delta !== null
            ? ` — ${formatDeltaSummary(model, tile, metricName, delta, percentChange)} vs ${priorPeriod ?? "prior period"}`
            : "";
        headlineBullets.push(`${ tileTitle }: ${formattedValue}${periodLabel}${deltaText}`);
      }
    }
  }

  const provenanceHash = computeProvenanceHash({
    modelName: model.name,
    title: spec.title,
    principal,
    kpis,
    caveats,
  });

  return {
    title: spec.title,
    generatedAt,
    principal,
    kpis,
    headlineBullets,
    caveats,
    provenanceHash,
  };
}

/**
 * Formats an ExecutiveDigest into a clean, Slack/board-memo-ready Markdown brief
 * with a "Verified by Semantic Canvas" provenance footer.
 */
export function formatDigestMarkdown(digest: ExecutiveDigest): string {
  const lines: string[] = [];
  lines.push(`# ${digest.title} — Executive Digest`);
  lines.push("");
  lines.push(
    `Generated: ${digest.generatedAt}${digest.principal ? ` · Principal: ${digest.principal}` : ""}`,
  );
  lines.push("");
  lines.push("## Headline Summary");
  if (digest.headlineBullets.length > 0) {
    for (const bullet of digest.headlineBullets) {
      lines.push(`- ${bullet}`);
    }
  } else {
    lines.push("- No metric headlines available.");
  }
  lines.push("");
  lines.push("## Caveats & Data Honesty");
  if (digest.caveats.length > 0) {
    for (const caveat of digest.caveats) {
      lines.push(`- ${caveat}`);
    }
  } else {
    lines.push("- None — all queried periods are complete and reviewed.");
  }
  lines.push("");
  lines.push("---");
  lines.push(`Verified by Semantic Canvas · Provenance: \`${digest.provenanceHash}\``);
  return lines.join("\n");
}

function computeBundleSignature(payload: {
  version: 1;
  title: string;
  generatedAt: string;
  digest: ExecutiveDigest;
  specSummary: { tiles: number };
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: payload.version,
        title: payload.title,
        generatedAt: payload.generatedAt,
        digest: payload.digest,
        specSummary: payload.specSummary,
      }),
    )
    .digest("hex");
}

/**
 * Packages a zero-credential shareable VerifiedBriefBundle with a SHA-256 signatureHash.
 */
export function exportVerifiedBriefBundle(
  spec: DashboardSpec,
  digest: Awaited<ReturnType<typeof generateExecutiveDigest>>,
): VerifiedBriefBundle {
  const base = {
    version: 1 as const,
    title: spec.title,
    generatedAt: digest.generatedAt,
    digest: structuredClone(digest),
    specSummary: { tiles: spec.tiles.length },
  };
  const signatureHash = computeBundleSignature(base);
  return {
    ...base,
    signatureHash,
  };
}

/**
 * Verifies tamper integrity of a shareable VerifiedBriefBundle.
 */
export function verifyBriefBundle(bundle: unknown): { valid: boolean; reason?: string } {
  if (!bundle || typeof bundle !== "object") {
    return { valid: false, reason: "Bundle must be a non-null object." };
  }
  const candidate = bundle as Record<string, unknown>;
  if (candidate.version !== 1) {
    return { valid: false, reason: "Unsupported or missing bundle version." };
  }
  if (typeof candidate.title !== "string" || typeof candidate.generatedAt !== "string") {
    return { valid: false, reason: "Bundle is missing title or generatedAt." };
  }
  if (!candidate.digest || typeof candidate.digest !== "object") {
    return { valid: false, reason: "Bundle is missing digest payload." };
  }
  const specSummary = candidate.specSummary as { tiles?: unknown } | undefined;
  if (!specSummary || typeof specSummary !== "object" || typeof specSummary.tiles !== "number") {
    return { valid: false, reason: "Bundle is missing specSummary.tiles." };
  }
  if (typeof candidate.signatureHash !== "string" || !/^[a-f0-9]{64}$/.test(candidate.signatureHash)) {
    return { valid: false, reason: "Bundle is missing a valid SHA-256 signatureHash." };
  }
  const digestObj = candidate.digest as ExecutiveDigest;
  if (candidate.title !== digestObj.title || candidate.generatedAt !== digestObj.generatedAt) {
    return { valid: false, reason: "Bundle header metadata does not match digest metadata." };
  }

  const expectedSignature = computeBundleSignature({
    version: 1,
    title: candidate.title,
    generatedAt: candidate.generatedAt,
    digest: digestObj,
    specSummary: { tiles: specSummary.tiles },
  });

  if (expectedSignature !== candidate.signatureHash) {
    return { valid: false, reason: "Signature mismatch: bundle content has been tampered with." };
  }

  return { valid: true };
}
