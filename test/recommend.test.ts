import { describe, expect, it } from "vitest";
import { betterKind, coarserGrain, detectDegenerate, detectNoisy, recommend, type FieldProfile } from "../src/suggest/recommend.ts";
import { semanticHints, timeColumnOf, type Model } from "../src/semantic/model.ts";
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

  it("offers waterfall for several measures with no breakdown dimension", () => {
    // The real fct_mrr_movements shape: new_mrr/expansion_mrr/
    // contraction_mrr/churned_mrr are separate governed metrics, not one
    // metric broken out by a movement_type dimension -- so "named deltas"
    // here means several measures selected together, no dimension at all.
    const opts = recommend(["new_mrr", "expansion_mrr", "contraction_mrr", "churned_mrr"], []);
    expect(opts.find((o) => o.kind === "waterfall")).toBeDefined();
  });

  it("does not offer waterfall for a single bare measure", () => {
    expect(recommend(["revenue"], []).find((o) => o.kind === "waterfall")).toBeUndefined();
  });

  it("offers funnel for several measures with no breakdown dimension", () => {
    const opts = recommend(["web_sessions", "new_signups", "paying_subscribers"], []);
    expect(opts.find((o) => o.kind === "funnel")).toBeDefined();
  });

  it("does not offer funnel for a single bare measure", () => {
    expect(recommend(["revenue"], []).find((o) => o.kind === "funnel")).toBeUndefined();
  });

  it("offers a bar+line combo for exactly two measures over time", () => {
    const opts = recommend(["marketing_spend", "click_through_rate"], [dim({ role: "temporal", cardinality: 12 })]);
    const combo = opts.find((o) => o.kind === "combo");
    expect(combo).toBeDefined();
    expect(combo!.why).toMatch(/marketing_spend as bars, click_through_rate as a line/);
  });

  it("does not offer a combo for one measure or for three", () => {
    const oneMeasure = recommend(["revenue"], [dim({ role: "temporal", cardinality: 12 })]);
    expect(oneMeasure.find((o) => o.kind === "combo")).toBeUndefined();
    const threeMeasures = recommend(["a", "b", "c"], [dim({ role: "temporal", cardinality: 12 })]);
    expect(threeMeasures.find((o) => o.kind === "combo")).toBeUndefined();
  });

  it("does not offer a combo for a non-temporal dimension", () => {
    const opts = recommend(["marketing_spend", "click_through_rate"], [dim({ role: "categorical", cardinality: 5 })]);
    expect(opts.find((o) => o.kind === "combo")).toBeUndefined();
  });

  it("prefers a plain multi-series line over small multiples for few categories", () => {
    const dims2 = [dim({ role: "temporal", cardinality: 24 }), dim({ field: "channel", cardinality: 4 })];
    const opts = recommend(["revenue"], dims2);
    expect(opts[0].kind).toBe("line");
    const sm = opts.find((o) => o.kind === "smallMultiples")!;
    expect(sm.fit).toBe("possible");
  });

  it("prefers small multiples over a plain multi-series line once there are too many categories to overlay", () => {
    const dims2 = [dim({ role: "temporal", cardinality: 24 }), dim({ field: "channel", cardinality: 12 })];
    const opts = recommend(["revenue"], dims2);
    expect(opts[0].kind).toBe("smallMultiples");
    const line = opts.find((o) => o.kind === "line")!;
    expect(line.fit).toBe("good");
  });

  it("every option carries a reason", () => {
    for (const o of recommend(["revenue"], [dim({ role: "geo" })]))
      expect(o.why.length).toBeGreaterThan(10);
  });

  describe("semantic hints", () => {
    // One categorical dimension at a rankable cardinality offers both "bar"
    // and "barH" -- a good shape to prove a hint nudges the ORDER among
    // already-valid options without ever inventing a new one.
    const shape = () => [dim({ field: "channel", role: "categorical", cardinality: 10 })];

    it("nudges toward the kind the model's own text names, without a hint present", () => {
      const plain = recommend(["revenue"], shape());
      const hinted = recommend(["revenue"], shape(), "Top channels by spend -- a ranking of paid acquisition.");
      const barHPlain = plain.find((o) => o.kind === "barH")!;
      const barHHinted = hinted.find((o) => o.kind === "barH")!;
      expect(barHHinted.score).toBeGreaterThan(barHPlain.score);
      expect(barHHinted.why).toMatch(/model describes this as a ranking/);
    });

    it("never changes the structural fit label, only the ordering score", () => {
      const hinted = recommend(["revenue"], shape(), "a ranking of channels");
      const barH = hinted.find((o) => o.kind === "barH")!;
      // Whatever fit recommendByShape assigned on structure alone is
      // untouched -- the hint is a tie-breaker, not a verdict.
      const unhinted = recommend(["revenue"], shape()).find((o) => o.kind === "barH")!;
      expect(barH.fit).toBe(unhinted.fit);
    });

    it("does nothing when the hint text names a kind that isn't offered for this shape", () => {
      // A geo field never offers "heatmap" -- a "distribution" hint should
      // be inert here, not conjure an option the shape logic never produced.
      const opts = recommend(["revenue"], [dim({ role: "geo" })], "a distribution of country revenue");
      expect(opts.find((o) => o.kind === "heatmap")).toBeUndefined();
    });

    it("is inert for text that matches nothing", () => {
      const plain = recommend(["revenue"], shape());
      const hinted = recommend(["revenue"], shape(), "monthly recurring revenue by customer");
      expect(hinted.map((o) => o.score)).toEqual(plain.map((o) => o.score));
    });

    it("matching text can promote a same-fit option to the top", () => {
      const opts = recommend(["revenue"], shape(), "ranking of channels");
      expect(opts[0].kind).toBe("barH");
    });

    it("an unambiguous name like \"waterfall\" is a strong enough signal to beat a structurally \"good\" bar chart", () => {
      // The real payoff, the real shape: fct_mrr_movements' own metrics
      // (new_mrr, expansion_mrr, contraction_mrr, churned_mrr) selected
      // together with no breakdown dimension -- and the table itself is
      // documented with synonyms: [..., "mrr waterfall"].
      const measures = ["new_mrr", "expansion_mrr", "contraction_mrr", "churned_mrr"];
      const plain = recommend(measures, []);
      expect(plain[0].kind).not.toBe("waterfall"); // structure alone never picks it over bar
      const hinted = recommend(measures, [],
        "Every change in monthly recurring revenue, one row per movement. mrr movements, mrr waterfall");
      expect(hinted[0].kind).toBe("waterfall");
      expect(hinted[0].why).toMatch(/model describes this as a waterfall/);
    });

    it("an unambiguous name like \"funnel\" is a strong enough signal to beat a structurally \"good\" bar chart", () => {
      // fct_web_sessions' own description calls itself "top-of-funnel
      // conversion" -- the same real-model payoff as the waterfall case
      // above, this time for a stage-narrowing story instead of a
      // bridge-to-a-total one.
      const measures = ["web_sessions", "new_signups", "paying_subscribers"];
      const plain = recommend(measures, []);
      expect(plain[0].kind).not.toBe("funnel"); // structure alone never picks it over bar
      const hinted = recommend(measures, [],
        "Marketing-site sessions used for top-of-funnel conversion tracking.");
      expect(hinted[0].kind).toBe("funnel");
      expect(hinted[0].why).toMatch(/model describes this as a funnel/);
    });
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

  it("reads percent from a synonym when the label itself doesn't say it", () => {
    // Regression: logo_churn_annualized's own label, "Logo churn
    // (annualized)", drops the word "rate" its sibling logo_churn_rate
    // has -- name+label alone matched no percent keyword, so a real value
    // of 0.6 fell through to "compact" and rendered via SI-prefix
    // notation as "600m", reading like six hundred million. Its synonym
    // "yearly churn rate" carries the word that the label doesn't.
    expect(inferNumberStyle(model, t(["logo_churn_annualized"]))).toBe("percent");
  });

  it("does not let an unrelated synonym's substring falsely trigger the ratio check", () => {
    // Regression: new_signups' own synonym "registrations" contains the
    // five letters "ratio" embedded inside it (regisTRATIOns) -- an
    // unbounded substring match on "ratio" would misfire here once
    // synonyms joined the searched text at all.
    expect(inferNumberStyle(model, t(["new_signups"]))).toBe("compact");
  });

  it("does not read a multiple like LTV/CAC ratio as a percent just for saying 'ratio'", () => {
    // Regression: "ratio" alone used to trigger percent formatting, turning
    // a real ltv_cac_ratio value of 5.85 (conventionally "5.85x") into a
    // nonsense "585.0%" -- unlike retention or a conversion rate, this kind
    // of ratio isn't bounded to roughly [0, 1].
    expect(inferNumberStyle(model, t(["ltv_cac_ratio"]))).toBe("compact");
  });

  it("a multi-metric tile takes its style from the FIRST metric, not every label pooled together", () => {
    // A combo tile pairs exactly this shape on purpose -- a currency
    // measure with a rate measure -- so the whole point is that "retention"
    // showing up in the second metric's label must not turn the first
    // metric's own currency axis into a percent.
    expect(inferNumberStyle(model, t(["revenue", "retention"]))).toBe("currency");
    expect(inferNumberStyle(model, t(["retention", "revenue"]))).toBe("percent");
  });

  it("resolves auto to the inferred style", () =>
    expect(resolveFormat(model, t(["revenue"])).number).toBe("currency"));

  it("respects an explicit override", () =>
    expect(resolveFormat(model, { ...t(["revenue"]), format: { number: "plain" } }).number)
      .toBe("plain"));

  it("formats a ratio as a percent", () =>
    expect(makeFormatter({ ...DEFAULT_FORMAT, number: "percent" })(1.028)).toBe("102.8%"));
});

describe("betterKind", () => {
  it("suggests the top-ranked option when the current kind isn't it", () => {
    const opts = recommend(["revenue"], [dim({ role: "geo", isoLike: true, sample: ["US"] })]);
    expect(betterKind("table", opts)!.kind).toBe("map");
  });

  it("suggests nothing when the current kind is already the top pick", () => {
    const opts = recommend(["revenue"], [dim({ role: "temporal", cardinality: 24 })]);
    expect(betterKind(opts[0].kind, opts)).toBeNull();
  });

  it("suggests nothing for an empty option list", () => {
    expect(betterKind("bar", [])).toBeNull();
  });
});

describe("detectNoisy", () => {
  const rowsFor = (vals: number[]) => vals.map((v, i) => [i, v]);
  const columns = ["x", "value"];

  it("does not flag a smooth, gradually-changing series", () => {
    const vals = Array.from({ length: 24 }, (_, i) => i * 10);
    expect(detectNoisy(rowsFor(vals), columns, ["value"])).toHaveLength(0);
  });

  it("flags a series that zigzags across most of its range every step", () => {
    const vals = Array.from({ length: 24 }, (_, i) => (i % 2 === 0 ? 0 : 100));
    const found = detectNoisy(rowsFor(vals), columns, ["value"]);
    expect(found).toHaveLength(1);
    expect(found[0].measure).toBe("value");
  });

  it("does not flag a short series, even a noisy one -- too few points to mean anything", () => {
    const vals = Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? 0 : 100));
    expect(detectNoisy(rowsFor(vals), columns, ["value"])).toHaveLength(0);
  });

  it("ignores a flat series (zero range) rather than dividing by zero", () => {
    const vals = Array.from({ length: 24 }, () => 50);
    expect(detectNoisy(rowsFor(vals), columns, ["value"])).toHaveLength(0);
  });
});

describe("detectDegenerate", () => {
  const columns = ["movement_type", "new_mrr"];
  // Modeled directly on the real bug: new_mrr is already filtered to
  // movement_type = 'new' in the model, so breaking it down by
  // movement_type draws one real bar and four empty ones.
  const rows = [["churn", 0], ["contraction", 0], ["expansion", 0], ["new", 190000], ["reactivation", 0]];

  it("flags a breakdown where only one category actually carries a value", () => {
    const found = detectDegenerate(rows, columns, "movement_type", "new_mrr");
    expect(found).not.toBeNull();
    expect(found!.dominantValue).toBe("new");
  });

  it("does not flag a breakdown where more than one category has real values", () => {
    const varied = [["churn", -500], ["contraction", -200], ["expansion", 300], ["new", 190000], ["reactivation", 50]];
    expect(detectDegenerate(varied, columns, "movement_type", "new_mrr")).toBeNull();
  });

  it("flags a single-row result -- nothing to contrast against, even though its one value is non-zero", () => {
    // Modeled on the other real bug: MRR is already `status = 'active'`, so
    // grouping it by status can only ever return this one row -- no empty
    // bars to notice, just one bar with nothing to compare it to.
    const found = detectDegenerate([["active", 190000]], ["status", "mrr"], "status", "mrr");
    expect(found).not.toBeNull();
    expect(found!.dominantValue).toBe("active");
  });

  it("flags a single-row result even when its one value is zero -- still nothing to contrast against", () => {
    const found = detectDegenerate([["active", 0]], ["status", "mrr"], "status", "mrr");
    expect(found).not.toBeNull();
  });

  it("does not flag a breakdown where every category is zero -- a different problem (no data), not this one", () => {
    const allZero = [["churn", 0], ["contraction", 0], ["new", 0]];
    expect(detectDegenerate(allZero, columns, "movement_type", "new_mrr")).toBeNull();
  });
});

describe("coarserGrain", () => {
  it("steps day -> week -> month -> quarter -> year", () => {
    expect(coarserGrain("day")).toBe("week");
    expect(coarserGrain("week")).toBe("month");
    expect(coarserGrain("month")).toBe("quarter");
    expect(coarserGrain("quarter")).toBe("year");
  });

  it("has nowhere coarser than year", () => {
    expect(coarserGrain("year")).toBeNull();
  });
});

describe("timeColumnOf", () => {
  it("finds a table's own partition-key column", () => {
    expect(timeColumnOf(model, "fct_sales")).toBe("fct_sales.sold_on");
  });

  it("returns null for a table with no date-like column", () => {
    expect(timeColumnOf(model, "dim_users")).toBeNull();
  });

  it("returns null for an unknown table", () => {
    expect(timeColumnOf(model, "not_a_real_table")).toBeNull();
  });

  it("returns null for no table at all", () => {
    expect(timeColumnOf(model, null)).toBeNull();
  });

  it("does not use a lifecycle date column that isn't the partition key or a date-typed primary key", () => {
    // Modeled on the real bug: fct_subscriptions has started_on/ended_on
    // (both date-typed) but no partition key and no date-typed primary
    // key. Grouping a CURRENT-STATE metric like active MRR by started_on
    // produces a cohort breakdown -- each bucket only holds currently-active
    // rows that happen to share a start date -- not a real time trend, so
    // this must return null rather than picking started_on just because
    // it's a date column.
    const lifecycleOnly: Model = {
      source: "test", name: "t",
      tables: {
        fct_subs: {
          name: "fct_subs", grain: "one row per subscription", synonyms: [], partitionKeys: [],
          columns: [
            { name: "subscription_id", type: "string" },
            { name: "started_on", type: "date" }, { name: "ended_on", type: "date" },
          ],
        },
      },
      metrics: {}, joins: [],
    };
    expect(timeColumnOf(lifecycleOnly, "fct_subs")).toBeNull();
  });

  it("uses a date-typed primary key on a table grained by period, even with no partition key", () => {
    // Modeled on fct_saas_monthly: primary_key month, grain "one row per
    // calendar month" -- a genuinely safe trend column despite an empty
    // partition_keys list, since it isn't a Hive-partitioned fact table.
    const monthlyMart: Model = {
      source: "test", name: "t",
      tables: {
        fct_monthly: {
          name: "fct_monthly", grain: "one row per calendar month", synonyms: [], partitionKeys: [],
          primaryKey: "month",
          columns: [{ name: "month", type: "date" }, { name: "ending_mrr_usd", type: "double" }],
        },
      },
      metrics: {}, joins: [],
    };
    expect(timeColumnOf(monthlyMart, "fct_monthly")).toBe("fct_monthly.month");
  });
});

describe("semanticHints", () => {
  it("includes the base table's synonyms", () => {
    expect(semanticHints(model, ["revenue"])).toMatch(/sales/);
  });

  it("includes the metric's own synonyms too, not just the table's", () => {
    // live_revenue carries no synonyms of its own in the fixture, but
    // shares fct_sales as its base table -- the table's "sales" should
    // still come through even when the metric adds nothing.
    expect(semanticHints(model, ["live_revenue"])).toMatch(/sales/);
  });

  it("combines hints across multiple selected metrics", () => {
    const hints = semanticHints(model, ["revenue", "users"]);
    expect(hints).toMatch(/sales/);
  });

  it("is empty, not a crash, for an unknown metric name", () => {
    expect(semanticHints(model, ["not_a_real_metric"])).toBe("");
  });

  it("is empty for no metrics selected", () => {
    expect(semanticHints(model, [])).toBe("");
  });
});

describe("matchModel", () => {
  it("finds the subject from measure words, not table names", () => {
    expect(matchModel(model, "how is revenue doing").subject).toBe("fct_sales");
  });
  it("returns nothing for a query with no signal", () => {
    expect(matchModel(model, "the and of").metrics).toHaveLength(0);
  });
});
