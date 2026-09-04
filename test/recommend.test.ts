import { describe, expect, it } from "vitest";
import { recommend, type FieldProfile } from "../src/suggest/recommend.ts";
import { guidesFor, snapTo } from "../src/canvas/geometry.ts";
import { inferNumberStyle, makeFormatter, resolveFormat, DEFAULT_FORMAT } from "../src/format/format.ts";
import { matchModel } from "../src/suggest/match.ts";
import { model, tile } from "./fixtures.ts";
import type { TileSpec } from "../src/compiler/spec.ts";

const dim = (o: Partial<FieldProfile>): FieldProfile =>
  ({ field: "d", type: "string", cardinality: 5, sample: [], role: "categorical", ...o });
const best = (m: string[], d: FieldProfile[]) => recommend(m, d)[0];

describe("recommend", () => {
  it("puts Map first for a geographic field", () => {
    const o = best(["revenue"], [dim({ field: "country", role: "geo", cardinality: 10,
                                       sample: ["US", "GB"], isoLike: true })]);
    expect(o.kind).toBe("map");
    expect(o.why).toMatch(/country codes/);
  });

  it("refuses to chart a high-cardinality field and says why", () => {
    const opts = recommend(["revenue"], [dim({ field: "user_id", cardinality: 30000 })]);
    expect(opts[0].kind).toBe("table");
    expect(opts.find((o) => o.kind === "barH")!.fit).toBe("poor");
  });

  it("prefers a line for a temporal dimension", () => {
    expect(best(["revenue"], [dim({ role: "temporal", cardinality: 24 })]).kind).toBe("line");
  });

  it("still offers KPI card for a single measure over time, so switching to a chart and back is possible", () => {
    // A real KPI tile carries a time dimension (for its sparkline), so this
    // is the shape a headline KPI actually has -- if "kpi" isn't offered
    // here, clicking any other chart type from a KPI card is a one-way trip.
    const opts = recommend(["revenue"], [dim({ role: "temporal", cardinality: 24 })]);
    expect(opts.find((o) => o.kind === "kpi")).toBeDefined();
  });

  it("does not offer KPI card for more than one measure over time", () => {
    const opts = recommend(["revenue", "cost"], [dim({ role: "temporal", cardinality: 24 })]);
    expect(opts.find((o) => o.kind === "kpi")).toBeUndefined();
  });

  it("demotes bar when there are too many periods", () => {
    const opts = recommend(["revenue"], [dim({ role: "temporal", cardinality: 680 })]);
    expect(opts.find((o) => o.kind === "bar")!.fit).toBe("possible");
  });

  it("only offers a donut at low cardinality", () => {
    expect(recommend(["revenue"], [dim({ cardinality: 5 })])
      .find((o) => o.kind === "donut")!.fit).toBe("good");
    expect(recommend(["revenue"], [dim({ cardinality: 20 })])
      .find((o) => o.kind === "donut")!.fit).toBe("poor");
  });

  it("returns a KPI for a bare measure", () => {
    expect(best(["revenue"], []).kind).toBe("kpi");
  });

  it("every option carries a reason", () => {
    for (const o of recommend(["revenue"], [dim({ role: "geo" })]))
      expect(o.why.length).toBeGreaterThan(10);
  });
});

describe("guidesFor", () => {
  const box = (x: number, y: number) => ({ x, y, w: 100, h: 50 });

  it("snaps to a near edge and reports exactly that line", () => {
    const g = guidesFor(box(203, 0), [box(200, 300)]);
    expect(g.dx).toBe(-3);
    expect(g.lines.filter((l) => l.axis === "v")).toHaveLength(1);
    expect(g.lines[0].at).toBe(200);
  });

  it("never reports a line it did not snap to", () => {
    // Three candidates within tolerance; only the winner may be drawn.
    const g = guidesFor(box(204, 0), [box(200, 9), box(201, 9), box(206, 9)]);
    expect(g.lines.filter((l) => l.axis === "v").length).toBeLessThanOrEqual(1);
    if (g.lines.length) expect(box(204, 0).x + g.dx).toBe(g.lines[0].at);
  });

  it("does nothing outside the tolerance", () => {
    expect(guidesFor(box(400, 400), [box(0, 0)])).toMatchObject({ dx: 0, dy: 0, lines: [] });
  });
});

describe("snapTo", () => {
  it("rounds to the grid when on", () => expect(snapTo(13, 8, true)).toBe(16));
  it("rounds to whole pixels when off", () => expect(snapTo(13.6, 8, false)).toBe(14));
});

describe("number formatting from the semantic layer", () => {
  const t = (metrics: string[]) => tile({ metrics }) as TileSpec;

  it("reads currency out of a metric label", () =>
    expect(inferNumberStyle(model, t(["revenue"]))).toBe("currency"));

  it("reads percent out of a retention label", () =>
    expect(inferNumberStyle(model, t(["retention"]))).toBe("percent"));

  it("falls back to compact", () =>
    expect(inferNumberStyle(model, t(["users"]))).toBe("compact"));

  it("resolves auto to the inferred style", () =>
    expect(resolveFormat(model, t(["revenue"])).number).toBe("currency"));

  it("respects an explicit override", () =>
    expect(resolveFormat(model, { ...t(["revenue"]), format: { number: "plain" } }).number)
      .toBe("plain"));

  it("formats a ratio as a percent", () =>
    expect(makeFormatter({ ...DEFAULT_FORMAT, number: "percent" })(1.028)).toBe("102.8%"));
});

describe("matchModel", () => {
  it("finds the subject from measure words, not table names", () => {
    expect(matchModel(model, "how is revenue doing").subject).toBe("fct_sales");
  });
  it("returns nothing for a query with no signal", () => {
    expect(matchModel(model, "the and of").metrics).toHaveLength(0);
  });
});
