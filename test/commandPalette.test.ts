import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CommandPalette,
  PALETTE_CATEGORY_ORDER,
  findMatchedKeyword,
  groupPaletteItems,
  rankPaletteItems,
  scorePaletteItem,
  stepPaletteIndex,
  type PaletteItem,
} from "../src/app/CommandPalette.tsx";

const noop = () => {};

const SAMPLE_ITEMS: PaletteItem[] = [
  {
    id: "action:new",
    label: "New dashboard from scratch",
    subtitle: "Start an empty governed canvas",
    category: "Actions",
    keywords: ["new", "scratch", "blank"],
    shortcut: "⌘N",
    onSelect: noop,
  },
  {
    id: "action:coach",
    label: "Semantic Layer Coach & Dialect Converter",
    subtitle: "Score readiness & convert across 5 dialects",
    category: "Actions",
    keywords: ["coach", "snowflake", "metricflow", "glue", "cube", "duckglue"],
    onSelect: noop,
  },
  {
    id: "action:export-svg",
    label: "Export dashboard as Vector SVG",
    subtitle: "Print-grade scalable vector export",
    category: "Actions",
    keywords: ["export", "svg", "vector"],
    onSelect: noop,
  },
  {
    id: "theme:newsroom-dark",
    label: "Theme: Newsroom Dark",
    subtitle: "Deep slate for control rooms",
    category: "Themes",
    keywords: ["newsroom-dark", "boardroom-dark", "executive-slate", "dark"],
    onSelect: noop,
  },
  {
    id: "nav:registry",
    label: "Metric Registry",
    subtitle: "24 governed metrics, synonyms & SQL contracts",
    category: "Navigate",
    keywords: ["registry", "catalogue", "sql"],
    onSelect: noop,
  },
  {
    id: "metric:mrr",
    label: "Monthly Recurring Revenue",
    subtitle: "fct_subscriptions · simple",
    category: "Semantic Metrics",
    keywords: ["mrr", "fct_subscriptions", "arr", "topline", "bookings"],
    onSelect: noop,
  },
  {
    id: "metric:net_retention",
    label: "Net Dollar Retention",
    subtitle: "fct_subscriptions · ratio",
    category: "Semantic Metrics",
    keywords: ["net_retention", "fct_subscriptions", "nrr", "ndr", "churn"],
    onSelect: noop,
  },
  {
    id: "metric:aov",
    label: "Average Order Value",
    subtitle: "fct_orders · ratio",
    category: "Semantic Metrics",
    keywords: ["aov", "fct_orders", "basket_size"],
    onSelect: noop,
  },
];

describe("CommandPalette ranking & governed metric quick-launcher", () => {
  it("returns a shallow copy of all items in original order for empty or whitespace queries", () => {
    const emptyRanked = rankPaletteItems(SAMPLE_ITEMS, "");
    expect(emptyRanked).toEqual(SAMPLE_ITEMS);
    expect(emptyRanked).not.toBe(SAMPLE_ITEMS);

    const spaceRanked = rankPaletteItems(SAMPLE_ITEMS, "   ");
    expect(spaceRanked.map((i) => i.id)).toEqual(SAMPLE_ITEMS.map((i) => i.id));
  });

  it("enforces exact > prefix > word-boundary > substring > keyword/synonym > subtitle scoring", () => {
    const tierItems: PaletteItem[] = [
      {
        id: "subtitle-hit",
        label: "Active Customers",
        subtitle: "fct_rev_ledger · simple",
        category: "Semantic Metrics",
        onSelect: noop,
      },
      {
        id: "synonym-hit",
        label: "Gross Bookings",
        subtitle: "fct_orders · simple",
        category: "Semantic Metrics",
        keywords: ["rev_bookings", "topline"],
        onSelect: noop,
      },
      {
        id: "substring-hit",
        label: "Irreversible Cancellations",
        subtitle: "fct_orders · simple",
        category: "Semantic Metrics",
        onSelect: noop,
      },
      {
        id: "word-boundary-hit",
        label: "Deferred Rev Balance",
        subtitle: "fct_orders · simple",
        category: "Semantic Metrics",
        onSelect: noop,
      },
      {
        id: "prefix-hit",
        label: "Revenue Run-Rate",
        subtitle: "fct_orders · simple",
        category: "Semantic Metrics",
        onSelect: noop,
      },
      {
        id: "exact-hit",
        label: "Rev",
        subtitle: "fct_orders · simple",
        category: "Semantic Metrics",
        onSelect: noop,
      },
    ];

    const ranked = rankPaletteItems(tierItems, "rev");
    expect(ranked.map((item) => item.id)).toEqual([
      "exact-hit",
      "prefix-hit",
      "word-boundary-hit",
      "substring-hit",
      "synonym-hit",
      "subtitle-hit",
    ]);

    expect(scorePaletteItem(tierItems[5], "rev")).toBeGreaterThan(scorePaletteItem(tierItems[4], "rev"));
    expect(scorePaletteItem(tierItems[4], "rev")).toBeGreaterThan(scorePaletteItem(tierItems[3], "rev"));
    expect(scorePaletteItem(tierItems[3], "rev")).toBeGreaterThan(scorePaletteItem(tierItems[2], "rev"));
    expect(scorePaletteItem(tierItems[2], "rev")).toBeGreaterThan(scorePaletteItem(tierItems[1], "rev"));
    expect(scorePaletteItem(tierItems[1], "rev")).toBeGreaterThan(scorePaletteItem(tierItems[0], "rev"));
  });

  it("discovers governed metrics via business synonyms, SQL identifiers, and normalized underscores", () => {
    const arrHits = rankPaletteItems(SAMPLE_ITEMS, "ARR");
    expect(arrHits[0]?.id).toBe("metric:mrr");
    expect(findMatchedKeyword(arrHits[0]!, "ARR")).toBe("arr");

    const basketHits = rankPaletteItems(SAMPLE_ITEMS, "basket size");
    expect(basketHits[0]?.id).toBe("metric:aov");
    expect(findMatchedKeyword(basketHits[0]!, "basket size")).toBe("basket_size");

    // When the primary label itself matches, no redundant synonym pill is needed.
    expect(findMatchedKeyword(SAMPLE_ITEMS[5]!, "Recurring")).toBeNull();

    const snowflakeHits = rankPaletteItems(SAMPLE_ITEMS, "snowflake");
    expect(snowflakeHits[0]?.id).toBe("action:coach");

    const themeAliasHits = rankPaletteItems(SAMPLE_ITEMS, "boardroom-dark");
    expect(themeAliasHits[0]?.id).toBe("theme:newsroom-dark");
  });

  it("supports multi-token queries across label, table, and metric type while rejecting unmatched queries", () => {
    const svgHits = rankPaletteItems(SAMPLE_ITEMS, "export svg");
    expect(svgHits[0]?.id).toBe("action:export-svg");

    const ratioOrderHits = rankPaletteItems(SAMPLE_ITEMS, "fct_orders ratio");
    expect(ratioOrderHits[0]?.id).toBe("metric:aov");

    expect(rankPaletteItems(SAMPLE_ITEMS, "nonexistent_metric_xyz_999")).toEqual([]);
    expect(rankPaletteItems(SAMPLE_ITEMS, "revenue nonexistent_xyz_999")).toEqual([]);
  });

  it("groups categories canonically when idle and promotes the top-ranked category when searching", () => {
    const idleGroups = groupPaletteItems(SAMPLE_ITEMS, "");
    expect(idleGroups.map((g) => g.category)).toEqual([...PALETTE_CATEGORY_ORDER]);

    const arrRanked = rankPaletteItems(SAMPLE_ITEMS, "topline");
    const searchGroups = groupPaletteItems(arrRanked, "topline");
    expect(searchGroups[0]?.category).toBe("Semantic Metrics");
    expect(searchGroups[0]?.items[0]?.id).toBe("metric:mrr");
  });

  it("cycles keyboard selection cleanly with wrap-around", () => {
    expect(stepPaletteIndex(0, 1, 4)).toBe(1);
    expect(stepPaletteIndex(3, 1, 4)).toBe(0);
    expect(stepPaletteIndex(0, -1, 4)).toBe(3);
    expect(stepPaletteIndex(2, -1, 4)).toBe(1);
    expect(stepPaletteIndex(0, 1, 0)).toBe(0);
  });

  it("renders accessible combobox dialog markup, grouped options, shortcuts, and empty state", () => {
    expect(
      renderToStaticMarkup(React.createElement(CommandPalette, { open: false, onClose: noop, items: SAMPLE_ITEMS })),
    ).toBe("");

    const openHtml = renderToStaticMarkup(
      React.createElement(CommandPalette, { open: true, onClose: noop, items: SAMPLE_ITEMS }),
    );
    expect(openHtml).toContain('role="dialog"');
    expect(openHtml).toContain('aria-modal="true"');
    expect(openHtml).toContain('aria-label="Command palette"');
    expect(openHtml).toContain('role="combobox"');
    expect(openHtml).toContain('aria-expanded="true"');
    expect(openHtml).toContain('placeholder="Jump to a governed metric, run an action, or switch theme…"');
    expect(openHtml).toContain("Semantic Metrics");
    expect(openHtml).toContain("Monthly Recurring Revenue");
    expect(openHtml).toContain("⌘N");

    const emptyHtml = renderToStaticMarkup(
      React.createElement(CommandPalette, { open: true, onClose: noop, items: [] }),
    );
    expect(emptyHtml).toContain("No governed metrics, actions, or themes match");
  });
});
