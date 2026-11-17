/**
 * Several validation problems shown as one message. Problems are written as
 * standalone text -- some full sentences ("... would change the metric's
 * meaning."), some fragments ("no metrics"). Joining them blindly with "; "
 * produced seams like "meaning.; fct_saas_monthly.month ...". Full sentences
 * are joined as sentences; otherwise trailing periods are dropped before the
 * "; " separator. Repeated problems (a metric and its component can report
 * the same grain rule) are shown once.
 */
export function joinProblems(problems: Iterable<string | null | undefined>): string {
  const unique = [...new Set([...problems].map(p => (p ?? "").trim()).filter(Boolean))];
  if (unique.every(p => /[.!?]$/.test(p))) return unique.join(" ");
  return unique.map(p => p.replace(/\s*\.+$/, "")).join("; ");
}

/** One message for a list of `{ problem }` validation issues (or `{ message }` API issues). */
export function issuesText(issues: readonly { problem?: string; message?: string }[]): string {
  return joinProblems(issues.map(i => i.problem ?? i.message));
}
