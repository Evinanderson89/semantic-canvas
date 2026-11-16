import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import { inspectTileLineage } from "../src/compiler/lineage.ts";
import type { DashboardSpec, TileSpec } from "../src/compiler/spec.ts";
import { duckdbConnector } from "../src/connectors/duckdb.ts";
import type { Connector } from "../src/connectors/types.ts";
import { loadRls, type RlsConfig } from "../src/security/rls.ts";
import { duckglueAdapter } from "../src/semantic/duckglue.ts";
import type { Model } from "../src/semantic/model.ts";
import { checkSourceHealth } from "../src/sources/health.ts";
import { dashboardFromYaml, dashboardToYaml, diffDashboardSpecs } from "../src/store/codeSync.ts";

describe("BI SQL & Metric Lineage, Source Health, and Dashboard-as-Code Sync", () => {
  let sampleModel: Model;
  let sampleConn: Connector;
  let sampleRls: RlsConfig;

  beforeAll(async () => {
    const loaded = await duckglueAdapter.load("./sample-data/warehouse.yaml");
    if (!loaded) throw new Error("Failed to load sample-data/warehouse.yaml");
    sampleModel = loaded;
    sampleConn = await duckdbConnector("./sample-data/lake");
    sampleRls = await loadRls("./security/policies.yaml");
  });

  afterAll(async () => {
    await sampleConn?.close();
  });

  describe("inspectTileLineage", () => {
    it("compiles governed SQL, builds the metric DAG, resolves join hops, and tracks RLS filters", () => {
      const tile: TileSpec = {
        id: "t-mrr",
        title: "Active MRR by Country and Plan Tier",
        metrics: ["mrr"],
        dimensions: ["dim_users.country"],
        where: [
          {
            id: "f-plan",
            field: "dim_plans.plan_tier",
            source: "dimension",
            mode: "discrete",
            values: ["pro", "team"],
          },
          {
            id: "f-mrr-min",
            field: "mrr",
            source: "metric",
            mode: "range",
            min: 10,
          },
        ],
        layout: { x: 0, y: 0, w: 600, h: 360 },
      };

      const usPrincipal = sampleRls.principals.us_analyst ?? {
        id: "us_analyst",
        name: "US Analyst",
        country: "US",
      };

      const lineage = inspectTileLineage(sampleModel, sampleConn, tile, {
        rls: sampleRls,
        principal: usPrincipal,
        role: "editor",
      });

      expect(lineage.baseTable).toBe("fct_subscriptions");
      expect(lineage.sql).toContain("fct_subscriptions");
      expect(lineage.sql).toContain("LEFT JOIN");
      expect(lineage.sql).toContain("dim_users");
      expect(lineage.sql).toContain("dim_plans");
      expect(lineage.rlsApplied.length).toBeGreaterThan(0);

      expect(lineage.metricDag).toHaveLength(1);
      expect(lineage.metricDag[0]).toMatchObject({
        name: "mrr",
        baseTable: "fct_subscriptions",
        type: "simple",
        filter: "fct_subscriptions.status = 'active'",
        components: [
          expect.objectContaining({
            name: "mrr",
            baseTable: "fct_subscriptions",
            filter: "fct_subscriptions.status = 'active'",
          }),
        ],
      });

      expect(lineage.joins).toEqual([
        {
          left: "fct_subscriptions",
          leftOn: "user_id",
          right: "dim_users",
          rightOn: "user_id",
          type: "left",
          cardinality: "many_to_one",
        },
        {
          left: "fct_subscriptions",
          leftOn: "plan_id",
          right: "dim_plans",
          rightOn: "plan_id",
          type: "left",
          cardinality: "many_to_one",
        },
      ]);
    });

    it("expands ratio/derived metric components in metricDag and handles tiles without RLS", () => {
      const tile: TileSpec = {
        id: "t-ratio",
        metrics: ["mrr_per_subscriber"],
        dimensions: ["dim_users.country", "dim_users.signup_source"],
        layout: { x: 0, y: 0, w: 400, h: 300 },
      };

      const lineage = inspectTileLineage(sampleModel, sampleConn, tile);
      expect(lineage.rlsApplied).toEqual([]);
      expect(lineage.metricDag[0].type).toBe("ratio");
      expect(lineage.metricDag[0].components.map((c) => c.name)).toEqual([
        "mrr",
        "paying_subscribers",
      ]);
      // Deduplicates multiple dimensions on the same joined table
      expect(lineage.joins).toHaveLength(1);
      expect(lineage.joins[0].right).toBe("dim_users");
    });

    it("rejects an invalid tile during lineage inspection", () => {
      const badTile: TileSpec = {
        id: "t-bad",
        metrics: ["non_existent_metric"],
        dimensions: [],
        layout: { x: 0, y: 0, w: 400, h: 300 },
      };
      expect(() => inspectTileLineage(sampleModel, sampleConn, badTile)).toThrow(
        /unknown metric "non_existent_metric"/,
      );
    });
  });

  describe("checkSourceHealth", () => {
    it("evaluates freshness and SLA status across the sample warehouse tables", async () => {
      const report = await checkSourceHealth(sampleModel, sampleConn);
      expect(report.source).toBe("sample_warehouse");
      expect(report.referenceDate).toBe("2026-08-31");
      expect(report.tables.length).toBe(Object.keys(sampleModel.tables).length);
      expect(report.healthy).toBe(true);

      const eventsTable = report.tables.find((t) => t.table === "fct_events");
      expect(eventsTable).toBeDefined();
      expect(eventsTable!.rowCount).toBeGreaterThan(0);
      expect(eventsTable!.dateColumn).toBe("event_date");
      expect(eventsTable!.maxDate).toBe("2026-08-31");
      expect(eventsTable!.lagDays).toBe(0);
      expect(eventsTable!.status).toBe("fresh");
    });

    it("flags stale and empty tables according to period grain or reportingLagDays SLA", async () => {
      // Check against a future reference date so tables with date axes exceed their SLA
      const futureNow = new Date("2026-10-15T12:00:00Z");
      const staleReport = await checkSourceHealth(sampleModel, sampleConn, futureNow);
      expect(staleReport.referenceDate).toBe("2026-10-15");
      expect(staleReport.healthy).toBe(false);
      const staleEvents = staleReport.tables.find((t) => t.table === "fct_events");
      expect(staleEvents?.status).toBe("stale");
      expect(staleEvents?.lagDays).toBe(45);

      // Verify empty table and period grain SLA calculation (month=35, week=10, default=7)
      const mockConn: Connector = {
        ...sampleConn,
        relation: (t) => `"${t}"`,
        async execute(sql: string) {
          if (sql.includes('"empty_tbl"')) {
            return { columns: ["n", "min_d", "max_d"], rows: [[0, null, null]], sql, ms: 1 };
          }
          return {
            columns: ["n", "min_d", "max_d"],
            rows: [[10, new Date("2026-08-01T00:00:00Z"), new Date("2026-08-20T00:00:00Z")]],
            sql,
            ms: 1,
          };
        },
      };

      const customModel: Model = {
        source: "test",
        name: "custom_sla_model",
        tables: {
          empty_tbl: {
            name: "empty_tbl",
            synonyms: [],
            partitionKeys: ["d"],
            columns: [{ name: "d", type: "date" }],
            period: { column: "d", grain: "month" },
          },
          weekly_tbl: {
            name: "weekly_tbl",
            synonyms: [],
            partitionKeys: ["d"],
            columns: [{ name: "d", type: "date" }],
            period: { column: "d", grain: "week" },
            relation: { schema: "public", table: "weekly_tbl" },
          },
        },
        metrics: {},
        joins: [],
      };

      const customReport = await checkSourceHealth(
        customModel,
        mockConn,
        new Date("2026-08-25T12:00:00Z"),
      );
      expect(customReport.healthy).toBe(false);
      expect(customReport.tables[0]).toMatchObject({
        table: "empty_tbl",
        rowCount: 0,
        slaDays: 35,
        status: "empty",
      });
      expect(customReport.tables[1]).toMatchObject({
        table: "weekly_tbl",
        rowCount: 10,
        minDate: "2026-08-01",
        maxDate: "2026-08-20",
        lagDays: 5,
        slaDays: 10,
        status: "fresh",
      });
    });
  });

  describe("dashboardToYaml, dashboardFromYaml, and diffDashboardSpecs", () => {
    const baseSpec: DashboardSpec = {
      title: "Executive Subscription Pulse",
      description: "Monthly recurring revenue and customer growth.",
      tiles: [
        {
          id: "tile-mrr",
          title: "Active MRR",
          kind: "metric",
          metrics: ["mrr"],
          dimensions: ["dim_users.country"],
          chart: "bar",
          layout: { x: 24, y: 24, w: 600, h: 360 },
        },
        {
          id: "tile-events",
          title: "Daily Events",
          kind: "metric",
          metrics: ["event_count"],
          dimensions: ["month:event_date"],
          chart: "line",
          layout: { x: 648, y: 24, w: 600, h: 360 },
        },
      ],
      filters: [
        {
          id: "f-country",
          label: "Country",
          field: "dim_users.country",
          control: "select",
          scope: "report",
          bindings: [{ tileId: "tile-mrr", field: "dim_users.country" }],
        },
      ],
    };

    it("serializes deterministically with version: 1 and round-trips with model validation", () => {
      const doc = {
        id: "exec-pulse",
        name: "Executive Subscription Pulse",
        spec: baseSpec,
        canvas: DEFAULT_CANVAS,
      };

      const yaml1 = dashboardToYaml(doc);
      const yaml2 = dashboardToYaml({
        canvas: { ...DEFAULT_CANVAS },
        spec: { ...baseSpec },
        name: doc.name,
        id: doc.id,
      });

      expect(yaml1).toBe(yaml2);
      expect(yaml1).toMatch(/^version: 1\n/);

      const parsed = dashboardFromYaml(yaml1, sampleModel);
      expect(parsed).toEqual(doc);
    });

    it("rejects YAML with unknown metrics when validated against a model", () => {
      const badDoc = {
        id: "bad-dash",
        name: "Bad Dash",
        spec: {
          title: "Bad Dash",
          tiles: [
            {
              id: "t1",
              metrics: ["not_a_real_metric"],
              dimensions: [],
              layout: { x: 0, y: 0, w: 400, h: 300 },
            },
          ],
        },
        canvas: DEFAULT_CANVAS,
      };
      const yamlText = dashboardToYaml(badDoc);
      expect(() => dashboardFromYaml(yamlText, sampleModel)).toThrow(
        /unknown metric "not_a_real_metric"/,
      );
      expect(() => dashboardFromYaml("version: 2\nid: x\n")).toThrow(/Unsupported dashboard YAML version/);
      expect(() => dashboardFromYaml("not_an_object")).toThrow(/mapping object/);
      expect(() => dashboardFromYaml("version: 1\nid: ''\n")).toThrow(/non-empty id/);
    });

    it("computes structural diffs across titles, descriptions, tiles, and filters", () => {
      const afterSpec: DashboardSpec = {
        title: "Updated Subscription Pulse",
        description: "Updated description.",
        tiles: [
          {
            ...baseSpec.tiles[0],
            chart: "donut",
            dimensions: ["dim_plans.plan_tier"],
          },
          {
            id: "tile-new",
            title: "New Tile",
            kind: "metric",
            metrics: ["paying_subscribers"],
            dimensions: [],
            layout: { x: 24, y: 400, w: 400, h: 240 },
          },
        ],
        filters: [
          {
            id: "f-plan",
            label: "Plan Tier",
            field: "dim_plans.plan_tier",
            control: "select",
            scope: "report",
            bindings: [{ tileId: "tile-mrr", field: "dim_plans.plan_tier" }],
          },
        ],
      };

      const diff = diffDashboardSpecs(baseSpec, afterSpec);
      expect(diff).toEqual({
        titleChanged: true,
        descriptionChanged: true,
        addedTiles: ["tile-new"],
        removedTiles: ["tile-events"],
        modifiedTiles: [
          {
            id: "tile-mrr",
            changes: ["dimensions", "chart"],
          },
        ],
        filterChanges: {
          added: ["f-plan"],
          removed: ["f-country"],
        },
      });
    });
  });
});
