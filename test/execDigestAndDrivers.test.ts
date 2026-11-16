import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DashboardSpec } from "../src/compiler/spec.ts";
import { duckdbConnector } from "../src/connectors/duckdb.ts";
import type { Connector } from "../src/connectors/types.ts";
import { duckglueAdapter } from "../src/semantic/duckglue.ts";
import type { Model } from "../src/semantic/model.ts";
import {
  exportVerifiedBriefBundle,
  formatDigestMarkdown,
  generateExecutiveDigest,
  verifyBriefBundle,
} from "../src/suggest/digest.ts";
import { analyzeMetricDrivers } from "../src/suggest/drivers.ts";

describe("Executive Digest, Verified Brief Bundle & Metric Drivers", () => {
  let model: Model;
  let conn: Connector;

  beforeAll(async () => {
    const loaded = await duckglueAdapter.load(resolve(process.cwd(), "sample-data/warehouse.yaml"));
    if (!loaded) throw new Error("Failed to load sample-data/warehouse.yaml");
    model = loaded;
    conn = await duckdbConnector(resolve(process.cwd(), "sample-data/lake"));
  });

  afterAll(async () => {
    if (conn) await conn.close();
  });

  describe("analyzeMetricDrivers", () => {
    it("computes deterministic period-over-period totals and dimensional drivers on the sample warehouse", async () => {
      const result = await analyzeMetricDrivers(model, conn, {
        metric: "net_new_mrr",
        maxDimensions: 4,
        topN: 3,
      });

      expect(result.metric).toBe("net_new_mrr");
      expect(result.label).toBe("Net new MRR (USD)");
      expect(result.timeDimension).toBe("month:fct_mrr_movements.movement_date");
      expect(result.priorPeriod).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(result.latestPeriod).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(result.latestPeriod > result.priorPeriod).toBe(true);
      expect(result.delta).toBeCloseTo(result.latestTotal - result.priorTotal, 6);
      if (result.priorTotal !== 0) {
        expect(result.percentChange).toBeCloseTo(result.delta / Math.abs(result.priorTotal), 6);
      }

      expect(result.dimensions.length).toBeGreaterThan(0);
      expect(result.dimensions.length).toBeLessThanOrEqual(4);

      const movementTypeDim = result.dimensions.find(
        (d) => d.dimension === "fct_mrr_movements.movement_type",
      );
      expect(movementTypeDim).toBeDefined();
      expect(movementTypeDim!.segments.length).toBeGreaterThan(0);
      expect(movementTypeDim!.segments.length).toBeLessThanOrEqual(3);

      for (const dim of result.dimensions) {
        for (let i = 1; i < dim.segments.length; i++) {
          expect(Math.abs(dim.segments[i - 1].delta)).toBeGreaterThanOrEqual(
            Math.abs(dim.segments[i].delta),
          );
        }
        for (const seg of dim.segments) {
          expect(seg.delta).toBeCloseTo(seg.latest - seg.prior, 6);
          const expectedShare =
            result.delta === 0 ? 0 : seg.delta / Math.abs(result.delta);
          expect(seg.shareOfChange).toBeCloseTo(expectedShare, 6);
        }
      }
    });

    it("respects metric.timeDimension, custom filters, and maxDimensions/topN limits", async () => {
      const result = await analyzeMetricDrivers(model, conn, {
        metric: "web_sessions",
        where: [
          {
            id: "f1",
            field: "fct_web_sessions.channel",
            source: "dimension",
            mode: "discrete",
            values: ["organic", "paid_search", "social"],
          },
        ],
        maxDimensions: 2,
        topN: 2,
      });

      expect(result.metric).toBe("web_sessions");
      expect(result.timeDimension).toBe("month:fct_web_sessions.session_date");
      expect(result.dimensions.length).toBeLessThanOrEqual(2);
      for (const dim of result.dimensions) {
        expect(dim.segments.length).toBeLessThanOrEqual(2);
      }
    });

    it("rejects unknown metrics or metrics without a default time dimension", async () => {
      await expect(
        analyzeMetricDrivers(model, conn, { metric: "non_existent_metric" }),
      ).rejects.toThrow(/Unknown metric/);

      // mrr sits on fct_subscriptions which has no default time axis unless provided
      await expect(
        analyzeMetricDrivers(model, conn, { metric: "mrr" }),
      ).rejects.toThrow(/no default time dimension/);
    });
  });

  describe("generateExecutiveDigest, formatDigestMarkdown & VerifiedBriefBundle", () => {
    it("evaluates dashboard KPIs, comparison deltas, caveats, Markdown brief, and tamper-evident bundle", async () => {
      const customModel: Model = structuredClone(model);
      customModel.tables.fct_web_sessions.reportingLagDays = 5;
      customModel.metrics.draft_sessions = {
        ...customModel.metrics.web_sessions,
        name: "draft_sessions",
        label: "Draft Web Sessions",
        reviewed: false,
      };

      const spec: DashboardSpec = {
        title: "Board Operating Review",
        tiles: [
          {
            id: "heading-1",
            kind: "heading",
            text: "Headline Growth",
            metrics: [],
            dimensions: [],
            layout: { x: 0, y: 0, w: 1200, h: 48 },
          },
          {
            id: "tile-ending-mrr",
            title: "Ending MRR",
            metrics: ["ending_mrr"],
            dimensions: ["month:fct_saas_monthly.month"],
            compare: "prior",
            chart: "kpi",
            layout: { x: 0, y: 60, w: 300, h: 160 },
          },
          {
            id: "tile-nrr",
            title: "Net Revenue Retention",
            metrics: ["nrr"],
            dimensions: ["month:fct_saas_monthly.month"],
            compare: "prior",
            chart: "kpi",
            layout: { x: 320, y: 60, w: 300, h: 160 },
          },
          {
            id: "tile-sessions-lag",
            title: "Weekly Web Traffic",
            metrics: ["draft_sessions"],
            dimensions: ["week:fct_web_sessions.session_date"],
            compare: "prior",
            limit: 4,
            chart: "line",
            layout: { x: 0, y: 240, w: 620, h: 280 },
          },
          {
            id: "tile-live-mrr",
            title: "Total Active MRR",
            metrics: ["mrr"],
            dimensions: [],
            chart: "stat",
            layout: { x: 640, y: 60, w: 300, h: 160 },
          },
        ],
      };

      const digest = await generateExecutiveDigest(customModel, conn, spec, {
        role: "editor",
        principal: "exec-board@company.test",
      });

      expect(digest.title).toBe("Board Operating Review");
      expect(digest.principal).toBe("exec-board@company.test");
      expect(digest.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(digest.provenanceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(digest.kpis).toHaveLength(4);
      expect(digest.headlineBullets.length).toBeGreaterThanOrEqual(4);

      const endingMrrKpi = digest.kpis.find((k) => k.tileId === "tile-ending-mrr")!;
      expect(endingMrrKpi.headlineValue).toBeGreaterThan(0);
      expect(endingMrrKpi.delta).not.toBeNull();
      expect(endingMrrKpi.period).toBe("2026-08-01");

      // Caveats should surface unreviewed metric, truncation (limit: 4), partial edge period, and reporting lag
      expect(digest.caveats.some((c) => c.includes("unreviewed"))).toBe(true);
      expect(digest.caveats.some((c) => c.includes("truncated"))).toBe(true);
      expect(
        digest.caveats.some(
          (c) => c.includes("Partial") || c.includes("reporting lag") || c.includes("settles after"),
        ),
      ).toBe(true);

      const md = formatDigestMarkdown(digest);
      expect(md).toContain("# Board Operating Review — Executive Digest");
      expect(md).toContain("Principal: exec-board@company.test");
      expect(md).toContain("## Headline Summary");
      expect(md).toContain("## Caveats & Data Honesty");
      expect(md).toContain("Verified by Semantic Canvas");
      expect(md).toContain(digest.provenanceHash);

      const bundle = exportVerifiedBriefBundle(spec, digest);
      expect(bundle.version).toBe(1);
      expect(bundle.title).toBe("Board Operating Review");
      expect(bundle.specSummary).toEqual({ tiles: spec.tiles.length });
      expect(bundle.signatureHash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(bundle)).not.toMatch(/secret|password|token|apiKey/i);

      expect(verifyBriefBundle(bundle)).toEqual({ valid: true });

      // Tampering with a KPI value invalidates the bundle signature
      const tamperedValue = structuredClone(bundle);
      tamperedValue.digest.kpis[0].headlineValue = 999999999;
      const tamperedCheck = verifyBriefBundle(tamperedValue);
      expect(tamperedCheck.valid).toBe(false);
      expect(tamperedCheck.reason).toMatch(/tampered|mismatch/i);

      // Tampering with specSummary invalidates the bundle signature
      const tamperedTiles = structuredClone(bundle);
      tamperedTiles.specSummary.tiles = 99;
      expect(verifyBriefBundle(tamperedTiles).valid).toBe(false);

      // Malformed bundles are rejected cleanly
      expect(verifyBriefBundle(null).valid).toBe(false);
      expect(verifyBriefBundle({ version: 2 }).valid).toBe(false);
    });
  });
});
