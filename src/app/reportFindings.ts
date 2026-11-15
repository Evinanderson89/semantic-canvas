import { isScopeNote, type DataFinding } from "../suggest/resultQuality.ts";

export interface ReportFindingSource {
  id: string;
  title: string;
  scope: unknown;
  findings: DataFinding[];
}

/** Consolidate identical observations only within the same reporting scope.
 * Every affected chart keeps a reference; this does not infer a shared cause. */
export function reportFindings(sources: ReportFindingSource[]) {
  const groups = new Map<string, { finding: DataFinding; charts: { id: string; title: string }[] }>();
  for (const source of sources) for (const finding of source.findings) {
    const key = JSON.stringify([source.scope, finding]);
    let group = groups.get(key);
    if (!group) { group = { finding, charts: [] }; groups.set(key, group); }
    if (!group.charts.some(chart => chart.id === source.id)) group.charts.push({ id: source.id, title: source.title });
  }
  return [...groups.values()].sort((a, b) => Number(isScopeNote(a.finding)) - Number(isScopeNote(b.finding)))
    .map((group, i) => ({ ...group, number: i + 1 }));
}
