export interface KpiPoint { x: unknown; y: number }
/** Match dates rather than adjacent rows; null at the latest date stays unknown. */
export function kpiSummary(series: KpiPoint[], compare: "prior" | "first", grain?: string | null, previous?: number | null) {
  const raw = series.at(-1)?.y;
  const latest = raw != null && Number.isFinite(raw) ? raw : null;
  let basis: number | null | undefined;
  if (compare === "first") basis = series[0]?.y;
  else if (previous !== undefined) basis = previous;
  else if (grain && series.length > 1) {
    const key = String(series.at(-1)?.x).slice(0, 10);
    const date = new Date(`${key}T00:00:00Z`);
    if (grain === "day" || grain === "week") date.setUTCDate(date.getUTCDate() - (grain === "week" ? 7 : 1));
    else if (grain === "month" || grain === "quarter") date.setUTCMonth(date.getUTCMonth() - (grain === "quarter" ? 3 : 1));
    else if (grain === "year") date.setUTCFullYear(date.getUTCFullYear() - 1);
    if (Number.isFinite(+date)) basis = series.find((p) => String(p.x).slice(0, 10) === date.toISOString().slice(0, 10))?.y;
  }
  const delta = latest != null && basis != null && Number.isFinite(basis) && basis !== 0
    ? (latest - basis) / Math.abs(basis) : null;
  return { latest, delta };
}
