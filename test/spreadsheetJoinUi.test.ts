import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  applyJoinResolution,
  effectiveJoinResolution,
  formatFanoutImpactSummary,
  formatFanoutNumber,
  SpreadsheetJoinsSection,
} from "../src/app/SpreadsheetImport.tsx";
import {
  canShowSpreadsheetRefresh,
  Connections,
  SpreadsheetRefreshConflictCard,
  type SourceInfo,
  type SpreadsheetRefreshConflict,
} from "../src/app/Connections.tsx";
import {
  BroadsideHygieneProvenance,
  buildTileLineageSummary,
  ReportPresentation,
} from "../src/app/ReportPresentation.tsx";
import {
  buildSampleWorkbookPayload,
  type SpreadsheetDetectedJoin,
} from "../src/modeler/spreadsheetTypes.ts";
import { parseXlsxWorkbook, profileWorkbook } from "../src/modeler/spreadsheet.ts";
import type { Model } from "../src/semantic/model.ts";
import type { DashboardSpec } from "../src/compiler/spec.ts";

describe("SpreadsheetImport join preview & Broadside data-error callout UI", () => {
  it("renders honest match rates (<100% never rounded up to 100%) and N:1 verified badge on clean keys", () => {
    const cleanFull: SpreadsheetDetectedJoin = {
      leftTable: "orders",
      leftColumn: "customer_id",
      rightTable: "customers",
      rightColumn: "customer_id",
      matchRate: 1,
      include: true,
      rightKeyUnique: true,
    };
    const cleanNearFull: SpreadsheetDetectedJoin = {
      leftTable: "orders",
      leftColumn: "plan_id",
      rightTable: "plans",
      rightColumn: "plan_id",
      matchRate: 0.9999,
      unmatchedLeftRows: 1,
      include: true,
      rightKeyUnique: true,
    };
    const cleanPartial: SpreadsheetDetectedJoin = {
      leftTable: "orders",
      leftColumn: "region_id",
      rightTable: "regions",
      rightColumn: "region_id",
      matchRate: 0.996,
      unmatchedLeftRows: 2,
      include: true,
      rightKeyUnique: true,
    };

    const html = renderToStaticMarkup(
      React.createElement(SpreadsheetJoinsSection, {
        joins: [cleanFull, cleanNearFull, cleanPartial],
        onChange: () => {},
      }),
    );

    expect(html).toContain("100% matched · ✓ Unique key (N:1 verified)");
    expect(html).toContain("&lt;100% matched · ✓ Unique key (N:1 verified)");
    expect(html).toContain("(1 unmatched)");
    expect(html).toContain("99.6% matched · ✓ Unique key (N:1 verified)");
    expect(html).not.toContain("DATA ERROR CAUGHT");
  });

  it("renders exact duplicate lookup row callout and prevented dollar impact on roastery-2tab-xlsx sample", async () => {
    const built = await buildSampleWorkbookPayload("roastery-2tab-xlsx");
    const sheets = parseXlsxWorkbook(Uint8Array.from(Buffer.from(built.content, "base64")));
    const preview = profileWorkbook(built.fileName, sheets);

    const html = renderToStaticMarkup(
      React.createElement(SpreadsheetJoinsSection, {
        joins: preview.detectedJoins ?? [],
        sheets: preview.sheets ?? null,
        onChange: () => {},
      }),
    );

    expect(html).toContain("DATA ERROR CAUGHT · EXACT DUPLICATE LOOKUP ROW");
    expect(html).toContain("Caught 1 duplicate ID (STR-101) in Store Directory.Store ID");
    expect(html).toContain("inflate Net Sales from $528,200 to $688,200 (+$160,000 double-count)");
    expect(html).toContain("✓ Fan-out prevented (1 row/ID)");
    expect(html).toContain("rows #1, #6");
    expect(html).toContain("Exact duplicate across all columns");
    expect(html).toContain("Deduplicate key (1 row per ID)");
  });

  it("renders conflicting duplicate join key callout ($3,000 -> $6,000) and supports 3-way resolution transitions", () => {
    const conflictingJoin: SpreadsheetDetectedJoin = {
      leftTable: "sales",
      leftColumn: "customer_id",
      rightTable: "customers",
      rightColumn: "customer_id",
      matchRate: 1,
      include: false,
      rightKeyUnique: false,
      duplicateKeyCount: 1,
      duplicateRightRows: 1,
      allExactDuplicates: false,
      duplicateKeys: [
        {
          key: "CUST-01",
          rightRows: 2,
          rowNumbers: [1, 4],
          exactDuplicate: false,
          conflictingColumns: ["segment", "company"],
        },
      ],
      fanoutImpact: {
        metricColumn: "sales",
        metricLabel: "Sales",
        trueTotal: 3000,
        inflatedTotal: 6000,
        delta: 3000,
        multiplier: 2,
      },
      resolution: "exclude",
    };

    const pausedHtml = renderToStaticMarkup(
      React.createElement(SpreadsheetJoinsSection, {
        joins: [conflictingJoin],
        onChange: () => {},
      }),
    );

    expect(pausedHtml).toContain("DATA ERROR CAUGHT · CONFLICTING DUPLICATE JOIN KEY");
    expect(pausedHtml).toContain("Caught 1 duplicate ID (CUST-01) in customers.customer_id");
    expect(pausedHtml).toContain("joining raw rows would inflate Sales from $3,000 to $6,000 (+$3,000 double-count)");
    expect(pausedHtml).toContain("Conflicting columns: segment, company");
    expect(pausedHtml).toContain("⚠️ Duplicate key paused");

    expect(effectiveJoinResolution(conflictingJoin)).toBe("exclude");

    const deduped = applyJoinResolution(conflictingJoin, "deduplicate");
    expect(deduped).toMatchObject({ include: true, resolution: "deduplicate" });
    expect(effectiveJoinResolution(deduped)).toBe("deduplicate");

    const oneToMany = applyJoinResolution(conflictingJoin, "one_to_many");
    expect(oneToMany).toMatchObject({ include: true, resolution: "one_to_many" });
    expect(effectiveJoinResolution(oneToMany)).toBe("one_to_many");

    const oneToManyHtml = renderToStaticMarkup(
      React.createElement(SpreadsheetJoinsSection, {
        joins: [oneToMany],
        onChange: () => {},
      }),
    );
    expect(oneToManyHtml).toContain("1:N guarded (sums blocked)");

    const excludedAgain = applyJoinResolution(oneToMany, "exclude");
    expect(excludedAgain).toMatchObject({ include: false, resolution: "exclude" });

    expect(formatFanoutNumber(3000, true)).toBe("$3,000");
    expect(formatFanoutNumber(1250.5, true)).toBe("$1,250.50");
    expect(formatFanoutNumber(4200, false)).toBe("4,200");
    expect(
      formatFanoutImpactSummary(
        { metricColumn: "sales", metricLabel: "Sales", trueTotal: 3000, inflatedTotal: 6000, delta: 3000, multiplier: 2 },
        true,
      ),
    ).toBe("joining raw rows would inflate Sales from $3,000 to $6,000 (+$3,000 double-count)");
  });
});

describe("Connections spreadsheet refresh guard & sandbox visibility UI", () => {
  const sources: SourceInfo[] = [
    { id: "duckglue-local", label: "Sample Warehouse", adapter: "duckglue", status: "ready", connector: "duckdb", tables: 9, metrics: 28 },
    { id: "coffee-roastery-2tab", label: "Specialty Coffee Orders + Stores", adapter: "duckglue", status: "ready", connector: "duckdb", tables: 2, metrics: 4 },
    { id: "user-q3-workbook", label: "User Q3 Workbook", adapter: "duckglue", status: "ready", connector: "duckdb", tables: 2, metrics: 3 },
    { id: "prod-pg", label: "Prod Postgres", adapter: "duckglue", status: "ready", connector: "postgres", tables: 5, metrics: 12 },
  ];

  it("hides Refresh sheet on shared built-in sample worlds and non-DuckDB sources, while showing it on user-uploaded sheets", () => {
    expect(canShowSpreadsheetRefresh(sources[0], true)).toBe(false);
    expect(canShowSpreadsheetRefresh(sources[1], true)).toBe(false);
    expect(canShowSpreadsheetRefresh(sources[1], false)).toBe(false);
    expect(canShowSpreadsheetRefresh(sources[2], true)).toBe(true);
    expect(canShowSpreadsheetRefresh(sources[2], false)).toBe(true);
    expect(canShowSpreadsheetRefresh(sources[3], false)).toBe(false);

    const sandboxHtml = renderToStaticMarkup(
      React.createElement(Connections, {
        sources,
        activeId: "coffee-roastery-2tab",
        sandboxMode: true,
        onSelect: () => {},
        onRefresh: () => {},
        principals: [],
        policies: [],
      }),
    );
    const refreshOccurrences = sandboxHtml.match(/↻ Refresh sheet/g) ?? [];
    expect(refreshOccurrences).toHaveLength(1);
    expect(sandboxHtml).toContain("Public Sandbox (Read-Only Connections)");
  });

  it("renders HTTP 409 Refresh paused — Data error caught card with prevented $3,000 -> $6,000 impact and actions", () => {
    const conflict: SpreadsheetRefreshConflict = {
      sourceId: "user-q3-workbook",
      fileName: "Q3_Updated.xlsx",
      format: "xlsx",
      content: "UEsDBBQAAAAIA",
      message: "Duplicate key CUST-01 in customers.customer_id (2 rows) would inflate Sales from $3,000 to $6,000 (+$3,000 double-count).",
      duplicateJoins: [
        {
          leftTable: "sales",
          leftColumn: "customer_id",
          rightTable: "customers",
          rightColumn: "customer_id",
          matchRate: 1,
          include: true,
          rightKeyUnique: false,
          duplicateKeyCount: 1,
          duplicateKeys: [
            {
              key: "CUST-01",
              rightRows: 2,
              rowNumbers: [1, 2],
              exactDuplicate: false,
              conflictingColumns: ["segment"],
            },
          ],
          fanoutImpact: {
            metricColumn: "sales",
            metricLabel: "Sales",
            trueTotal: 3000,
            inflatedTotal: 6000,
            delta: 3000,
            multiplier: 2,
          },
        },
      ],
      canDeduplicate: true,
    };

    const html = renderToStaticMarkup(
      React.createElement(SpreadsheetRefreshConflictCard, {
        conflict,
        onDeduplicate: () => {},
        onDismiss: () => {},
      }),
    );

    expect(html).toContain("REFRESH PAUSED — DATA ERROR CAUGHT");
    expect(html).toContain("would inflate Sales from $3,000 to $6,000 (+$3,000 double-count)");
    expect(html).toContain("CUST-01 ×2, rows #1, #2, conflicts in segment");
    expect(html).toContain("Deduplicate key &amp; refresh");
    expect(html).toContain("Keep current clean data");

    const nonDedupableHtml = renderToStaticMarkup(
      React.createElement(SpreadsheetRefreshConflictCard, {
        conflict: { ...conflict, canDeduplicate: false },
        onDeduplicate: () => {},
        onDismiss: () => {},
      }),
    );
    expect(nonDedupableHtml).not.toContain("Deduplicate key &amp; refresh");
    expect(nonDedupableHtml).toContain("Keep current clean data");
  });
});

describe("Broadside colophon hygiene provenance UI", () => {
  const baseModel: Model = {
    source: "duckglue",
    name: "Specialty Coffee Orders + Stores",
    tables: {
      cafe_orders: {
        name: "cafe_orders",
        grain: "One sale or order",
        synonyms: [],
        partitionKeys: [],
        columns: [
          { name: "order_date", type: "DATE" },
          { name: "net_sales", type: "DOUBLE" },
        ],
      },
    },
    metrics: {
      net_sales: {
        name: "net_sales",
        label: "Net Sales",
        baseTable: "cafe_orders",
        expression: "SUM(net_sales)",
        synonyms: [],
      },
    },
    joins: [],
  };

  const spec: DashboardSpec = {
    title: "Roastery Brief",
    tiles: [
      {
        id: "t-note",
        kind: "text",
        title: "Summary",
        text: "Executive summary note.",
        metrics: [],
        dimensions: [],
        layout: { x: 0, y: 0, w: 600, h: 120 },
      },
    ],
  };

  it("renders model.hygieneNotes in the Broadside colophon footer when present and omits when empty", () => {
    expect(renderToStaticMarkup(React.createElement(BroadsideHygieneProvenance, { hygieneNotes: [] }))).toBe("");

    const modelWithHygiene: Model = {
      ...baseModel,
      hygieneNotes: [
        "Cafe Orders: Excluded 1 Total/Subtotal summary row to prevent double-counting",
        "Store Directory: Deduplicated 1 duplicate Store ID row (STR-101) — prevented $376,400 → $489,300 Net Sales double-count",
      ],
    };

    const posterHtml = renderToStaticMarkup(
      React.createElement(ReportPresentation, {
        spec,
        model: modelWithHygiene,
        mode: "infographic",
        queryContext: "ctx",
        filtersByTile: {},
        scopeWarnings: {},
        drills: {},
        checks: {},
        onReadiness: () => {},
      }),
    );

    expect(posterHtml).toContain("report-broadside-colophon");
    expect(posterHtml).toContain("report-hygiene-provenance");
    expect(posterHtml).toContain("✓ Data hygiene &amp; join safety verified");
    expect(posterHtml).toContain("Excluded 1 Total/Subtotal summary row to prevent double-counting");
    expect(posterHtml).toContain("prevented $376,400 → $489,300 Net Sales double-count");
    expect(posterHtml).not.toContain("SHA-256");

    const signedPosterHtml = renderToStaticMarkup(
      React.createElement(ReportPresentation, {
        spec,
        model: modelWithHygiene,
        mode: "infographic",
        queryContext: "ctx",
        filtersByTile: {},
        scopeWarnings: {},
        drills: {},
        checks: {},
        digestOverride: "a1b2c3d4e5f67890abcdef12",
        onReadiness: () => {},
      }),
    );
    expect(signedPosterHtml).toContain("sha256: a1b2c3d4e5f6…");

    const orphanJoin: SpreadsheetDetectedJoin = {
      leftTable: "cafe_orders",
      leftColumn: "store_id",
      rightTable: "store_directory",
      rightColumn: "store_id",
      matchRate: 0.94,
      unmatchedLeftRows: 2,
      orphanLeftDollarTotal: 14500,
      orphanMetricLabel: "Net Sales ($)",
      include: true,
      rightKeyUnique: true,
    };
    const orphanHtml = renderToStaticMarkup(
      React.createElement(SpreadsheetJoinsSection, {
        joins: [orphanJoin],
        onChange: () => {},
      }),
    );
    expect(orphanHtml).toContain("$14,500 of Net Sales ($) across 2 unmatched cafe_orders rows");
    expect(orphanHtml).toContain("Unassigned");

    const lineageModel: Model = {
      ...baseModel,
      tables: {
        ...baseModel.tables,
        store_directory: {
          name: "store_directory",
          grain: "One store",
          synonyms: [],
          partitionKeys: [],
          columns: [
            { name: "store_id", type: "VARCHAR" },
            { name: "city", type: "VARCHAR" },
          ],
        },
      },
      joins: [
        {
          left: "cafe_orders",
          leftOn: "store_id",
          right: "store_directory",
          rightOn: "store_id",
          type: "left",
          cardinality: "many_to_one",
        },
      ],
    };
    const lineage = buildTileLineageSummary(
      lineageModel,
      {
        id: "t-sales",
        title: "Sales by City",
        metrics: ["net_sales"],
        dimensions: ["store_directory.city"],
        layout: { x: 0, y: 0, w: 400, h: 240 },
      },
      {
        id: "t-sales",
        metrics: ["net_sales"],
        dimensions: ["store_directory.city"],
        where: [],
        limit: undefined,
        compare: undefined,
      },
    );
    expect(lineage.joins).toContain("cafe_orders.store_id → store_directory.store_id (many_to_one)");
    expect(lineage.sql).toContain("LEFT JOIN store_directory ON cafe_orders.store_id = store_directory.store_id");
  });
});
