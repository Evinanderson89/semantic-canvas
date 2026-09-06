import type { DashboardSpec } from "../compiler/spec.ts";
import type { Model } from "../semantic/model.ts";

/**
 * A fixed, checked-in "before" dashboard -- not generated, deliberately
 * imperfect -- so a new user can open it, click Beautify or Smart Arrange,
 * and see a REAL fix happen on the first try, instead of having to already
 * know what a magnitude mismatch or a degenerate breakdown looks like
 * before they can go find one. `suggestDashboard()` is built to avoid
 * these problems by construction, which is exactly why it's a poor demo
 * of the tools that catch them -- there's usually nothing left to fix.
 *
 * Each tile earns its place by triggering ONE specific, real rule this
 * app ships, not a hypothetical:
 *  - d1: a bare KPI, included as the one tile that's already fine --
 *    contrast for the other three, not something to fix.
 *  - d2: `web_sessions` at day grain -- genuinely noisy real data (see
 *    `detectNoisy()` in recommend.ts), so Beautify offers coarsening to
 *    week.
 *  - d3: `new_mrr` by `movement_type` -- the exact reported bug
 *    `detectDegenerate()` exists for (every category but "new" reads
 *    zero, since new_mrr is already filtered to `movement_type = 'new'`),
 *    PLUS a chart-kind mismatch: explicitly a bar chart even though
 *    `fct_mrr_movements`'s own synonyms name it a "mrr waterfall",
 *    so Beautify separately offers "Might read better as Waterfall".
 *  - d4: `new_signups` by `dim_users.country` -- geographic data
 *    explicitly rendered as a table, so Beautify offers "Might read
 *    better as Map".
 *
 * The layout is deliberately overlapping and inconsistently sized, the
 * same free-positioning the canvas always allows (see Canvas.tsx) -- so
 * Smart Arrange has an honest, visible mess to clean up rather than a
 * layout already close enough that the fix is hard to notice.
 */
export function demoDashboardAvailable(model: Model): boolean {
  const metrics = ["mrr", "web_sessions", "new_mrr", "new_signups"];
  const tables = ["fct_mrr_movements", "dim_users", "fct_web_sessions"];
  return metrics.every((m) => m in model.metrics) && tables.every((t) => t in model.tables);
}

export function demoDashboard(): DashboardSpec {
  return {
    title: "SaaS Overview (rough draft)",
    description: "Deliberately unpolished -- try Beautify (the wand icon, in "
      + "edit mode) on d2-d4, and Smart Arrange on the whole thing.",
    tiles: [
      { id: "d1", kind: "metric", title: "MRR (USD)", metrics: ["mrr"], dimensions: [],
        layout: { x: 40, y: 40, w: 260, h: 130 } },
      { id: "d2", kind: "metric", title: "Web sessions", metrics: ["web_sessions"],
        dimensions: ["day:fct_web_sessions.session_date"], chart: "line",
        layout: { x: 220, y: 110, w: 560, h: 280 } },
      { id: "d3", kind: "metric", title: "New MRR (USD) by movement_type", metrics: ["new_mrr"],
        dimensions: ["fct_mrr_movements.movement_type"], chart: "bar",
        layout: { x: 700, y: 60, w: 380, h: 260 } },
      { id: "d4", kind: "metric", title: "New signups by country", metrics: ["new_signups"],
        dimensions: ["dim_users.country"], chart: "table",
        layout: { x: 80, y: 400, w: 900, h: 260 } },
    ],
  };
}
