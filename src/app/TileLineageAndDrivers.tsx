import { useState } from "react";
import type { TileSpec } from "../compiler/spec.ts";
import { metricOf, type Model } from "../semantic/model.ts";
import { readResponse } from "./http.ts";

export interface ReferenceLineItem {
  label: string;
  value: number;
}

export function getTileReferenceLines(tile: TileSpec): ReferenceLineItem[] {
  if (Array.isArray(tile.format?.referenceLines) && tile.format!.referenceLines!.length > 0) {
    return tile.format!.referenceLines!;
  }
  if (typeof tile.format?.targetValue === "number" && Number.isFinite(tile.format.targetValue)) {
    return [
      {
        label: tile.format.targetLabel?.trim() || `Target ${tile.format.targetValue}`,
        value: tile.format.targetValue,
      },
    ];
  }
  return [];
}

export function addTileReferenceLine(
  tile: TileSpec,
  label: string,
  value: number,
): TileSpec {
  if (!Number.isFinite(value)) return tile;
  const cleanLabel = label.trim() || `Target ${value}`;
  const current = getTileReferenceLines(tile);
  const nextLines = [...current, { label: cleanLabel, value }];
  return {
    ...tile,
    format: {
      ...tile.format,
      referenceLines: nextLines,
      targetValue: nextLines[0]?.value ?? null,
      targetLabel: nextLines[0]?.label ?? null,
    },
  };
}

export function removeTileReferenceLine(tile: TileSpec, index: number): TileSpec {
  const current = getTileReferenceLines(tile);
  const nextLines = current.filter((_, i) => i !== index);
  return {
    ...tile,
    format: {
      ...tile.format,
      referenceLines: nextLines,
      targetValue: nextLines[0]?.value ?? null,
      targetLabel: nextLines[0]?.label ?? null,
    },
  };
}

export function buildLineagePayload(tile: TileSpec) {
  return {
    metrics: tile.metrics,
    dimensions: tile.dimensions ?? [],
    where: tile.where ?? [],
  };
}

export interface NormalizedLineageView {
  sql: string;
  metrics: { name: string; label: string; type: string; baseTable: string; expression: string }[];
  tables: string[];
  joins: { left: string; leftOn: string; right: string; rightOn: string; type: string; cardinality: string }[];
  filters: string[];
}

export function normalizeLineagePayload(raw: any): NormalizedLineageView {
  const rawMetrics: any[] = Array.isArray(raw?.metrics)
    ? raw.metrics
    : Array.isArray(raw?.metricDag)
      ? raw.metricDag
      : [];
  const rawJoins: any[] = Array.isArray(raw?.joins) ? raw.joins : [];
  const tables: string[] = Array.isArray(raw?.tables)
    ? raw.tables.map(String)
    : Array.from(
        new Set([raw?.baseTable, ...rawJoins.map((j) => j.right)].filter(Boolean).map(String)),
      );
  const filters: string[] = Array.isArray(raw?.filters)
    ? raw.filters.map(String)
    : Array.isArray(raw?.rlsApplied)
      ? raw.rlsApplied.map(String)
      : [];
  return {
    sql: String(raw?.sql ?? ""),
    metrics: rawMetrics.map((m) => ({
      name: String(m.name ?? ""),
      label: String(m.label ?? m.name ?? ""),
      type: String(m.type ?? "simple"),
      baseTable: String(m.baseTable ?? ""),
      expression: String(m.expression ?? ""),
    })),
    tables,
    joins: rawJoins.map((j) => ({
      left: String(j.left ?? ""),
      leftOn: String(j.leftOn ?? ""),
      right: String(j.right ?? ""),
      rightOn: String(j.rightOn ?? ""),
      type: String(j.type ?? "left"),
      cardinality: String(j.cardinality ?? "many_to_one"),
    })),
    filters,
  };
}

export function buildDriversPayload(tile: TileSpec) {
  return {
    metric: tile.metrics[0] ?? "",
  };
}

export interface NormalizedDriversView {
  metric: string;
  label: string;
  priorPeriod: string;
  latestPeriod: string;
  delta: number;
  dimensions: {
    dimension: string;
    label: string;
    topDrivers: {
      value: string;
      contribution: number;
      share: number;
    }[];
  }[];
}

export function normalizeDriversPayload(raw: any): NormalizedDriversView {
  const rawDims: any[] = Array.isArray(raw?.dimensions) ? raw.dimensions : [];
  return {
    metric: String(raw?.metric ?? ""),
    label: String(raw?.label ?? raw?.metric ?? ""),
    priorPeriod: String(raw?.priorPeriod ?? ""),
    latestPeriod: String(raw?.latestPeriod ?? ""),
    delta: Number(raw?.delta ?? 0),
    dimensions: rawDims.map((d) => {
      const driversList: any[] = Array.isArray(d.topDrivers)
        ? d.topDrivers
        : Array.isArray(d.drivers)
          ? d.drivers
          : Array.isArray(d.segments)
            ? d.segments
            : [];
      return {
        dimension: String(d.dimension ?? ""),
        label: String(d.label ?? d.dimension ?? ""),
        topDrivers: driversList.map((s) => ({
          value: String(s.value ?? s.segment ?? ""),
          contribution: Number(s.contribution ?? s.delta ?? 0),
          share: Number(s.share ?? s.shareOfChange ?? 0),
        })),
      };
    }),
  };
}

export function TileLineageAndDriversSection({
  model,
  tile,
  onChange,
}: {
  model: Model;
  tile: TileSpec;
  onChange: (t: TileSpec) => void;
}) {
  const [targetLabel, setTargetLabel] = useState("");
  const [targetValueInput, setTargetValueInput] = useState("");

  const [lineage, setLineage] = useState<NormalizedLineageView | null>(null);
  const [lineageLoading, setLineageLoading] = useState(false);
  const [lineageError, setLineageError] = useState("");
  const [copiedSql, setCopiedSql] = useState(false);

  const [drivers, setDrivers] = useState<NormalizedDriversView | null>(null);
  const [driversLoading, setDriversLoading] = useState(false);
  const [driversError, setDriversError] = useState("");

  const referenceLines = getTileReferenceLines(tile);
  const primaryMetricLabel = tile.metrics[0]
    ? metricOf(model, tile.metrics[0])?.label ?? tile.metrics[0]
    : "";

  const handleAddReferenceLine = () => {
    const num = Number(targetValueInput);
    if (targetValueInput.trim() === "" || !Number.isFinite(num)) return;
    onChange(addTileReferenceLine(tile, targetLabel, num));
    setTargetLabel("");
    setTargetValueInput("");
  };

  const handleInspectLineage = async () => {
    setLineageLoading(true);
    setLineageError("");
    try {
      const res = await fetch("/api/query/lineage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildLineagePayload(tile)),
      }).then(readResponse);
      setLineage(normalizeLineagePayload(res));
    } catch (e: any) {
      setLineageError(e?.message ?? "Could not inspect SQL & lineage");
    } finally {
      setLineageLoading(false);
    }
  };

  const handleAnalyzeDrivers = async () => {
    if (!tile.metrics.length) return;
    setDriversLoading(true);
    setDriversError("");
    try {
      const res = await fetch("/api/query/drivers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildDriversPayload(tile)),
      }).then(readResponse);
      setDrivers(normalizeDriversPayload(res));
    } catch (e: any) {
      setDriversError(e?.message ?? "Could not analyze metric drivers");
    } finally {
      setDriversLoading(false);
    }
  };

  return (
    <>
      <section className="ins-sec">
        <h5>Annotations & Target Lines</h5>
        <div className="mini-row">
          <input
            className="txt"
            aria-label="Target line label"
            placeholder="Label (e.g. Q4 Goal)"
            value={targetLabel}
            onChange={(e) => setTargetLabel(e.target.value)}
          />
          <input
            className="txt"
            type="number"
            step="any"
            aria-label="Target line value"
            placeholder="Value"
            value={targetValueInput}
            onChange={(e) => setTargetValueInput(e.target.value)}
          />
          <button className="use" onClick={handleAddReferenceLine}>
            Add target
          </button>
        </div>
        {referenceLines.length > 0 && (
          <ul className="ref-lines-list">
            {referenceLines.map((line, idx) => (
              <li key={`${line.label}-${idx}`} className="mini-row">
                <span>
                  <b>{line.label}</b>: {line.value}
                </span>
                <button
                  className="link"
                  aria-label={`Remove target ${line.label}`}
                  onClick={() => onChange(removeTileReferenceLine(tile, idx))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="ins-sec">
        <h5>SQL & Metric Lineage DAG</h5>
        <button className="use" disabled={lineageLoading} onClick={handleInspectLineage}>
          {lineageLoading ? "Inspecting…" : "Inspect SQL & Lineage"}
        </button>
        {lineageError && <p className="sm" role="alert">{lineageError}</p>}
        {lineage && (
          <div className="lineage-panel">
            <p className="sm">
              <b>Metrics:</b> {lineage.metrics.map((m) => `${m.label} (${m.type})`).join(", ") || "None"}
            </p>
            <p className="sm">
              <b>Tables:</b> {lineage.tables.join(", ") || "None"}
            </p>
            {lineage.joins.length > 0 && (
              <p className="sm">
                <b>Joins:</b>{" "}
                {lineage.joins
                  .map((j) => `${j.left}.${j.leftOn} → ${j.right}.${j.rightOn} (${j.cardinality})`)
                  .join(", ")}
              </p>
            )}
            {lineage.filters.length > 0 && (
              <p className="sm">
                <b>Filters:</b> {lineage.filters.join(", ")}
              </p>
            )}
            <pre className="sql-preview">
              <code>{lineage.sql}</code>
            </pre>
            <button
              className="link"
              onClick={() => {
                void navigator.clipboard?.writeText(lineage.sql);
                setCopiedSql(true);
              }}
            >
              {copiedSql ? "Copied SQL" : "Copy SQL"}
            </button>
          </div>
        )}
      </section>

      {tile.metrics.length > 0 && (
        <section className="ins-sec">
          <h5>“Why Did This Move?” Driver Attribution</h5>
          <p className="muted sm">Decompose movement for {primaryMetricLabel}.</p>
          <button className="use" disabled={driversLoading} onClick={handleAnalyzeDrivers}>
            {driversLoading ? "Analyzing…" : "Analyze Metric Drivers"}
          </button>
          {driversError && <p className="sm" role="alert">{driversError}</p>}
          {drivers && (
            <div className="drivers-panel">
              <p className="sm">
                <b>{drivers.label}</b> ({drivers.priorPeriod} → {drivers.latestPeriod}): Δ{" "}
                {drivers.delta > 0 ? `+${drivers.delta}` : drivers.delta}
              </p>
              {drivers.dimensions.map((d) => (
                <div key={d.dimension} className="driver-dim-group">
                  <b>{d.dimension}</b>
                  <ul>
                    {d.topDrivers.map((drv) => (
                      <li key={drv.value} className="sm">
                        <span>{drv.value}</span>:{" "}
                        <b>{drv.contribution > 0 ? `+${drv.contribution}` : drv.contribution}</b>{" "}
                        <em>({Math.round(drv.share * 100)}% share)</em>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </>
  );
}
