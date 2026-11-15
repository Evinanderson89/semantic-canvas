import { isScopeNote, type DataFinding } from "../suggest/resultQuality.ts";

export interface ReportFindingSource {
  id: string;
  title: string;
  scope: unknown;
  findings: DataFinding[];
}

/** Data-quality observations stay scoped. Identical reporting-scope guidance
 * can be shared across charts: each chart retains its own scope and reference,
 * and the report explicitly says those checks apply independently. */
export function reportFindings(sources: ReportFindingSource[]) {
  const groups = new Map<string, { finding: DataFinding; charts: { id: string; title: string }[]; scopeKeys: Set<string | undefined> }>();
  for (const source of sources) for (const finding of source.findings) {
    const scopeKey = JSON.stringify(source.scope);
    const key = JSON.stringify([isScopeNote(finding) ? null : source.scope, finding]);
    let group = groups.get(key);
    if (!group) { group = { finding, charts: [], scopeKeys: new Set() }; groups.set(key, group); }
    group.scopeKeys.add(scopeKey);
    if (!group.charts.some(chart => chart.id === source.id)) group.charts.push({ id: source.id, title: source.title });
  }
  return [...groups.values()].sort((a, b) => Number(isScopeNote(a.finding)) - Number(isScopeNote(b.finding)))
    .map(({ scopeKeys, ...group }, i) => ({ ...group, number: i + 1,
      ...(isScopeNote(group.finding) && scopeKeys.size > 1 ? { independentScopes: scopeKeys.size } : {}),
    }));
}
