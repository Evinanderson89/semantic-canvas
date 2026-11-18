import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { applyProposal, proposalSchema } from "../src/canvas/proposals.ts";
import { redesignToolSchema, strictToolSchema } from "../src/agent/redesignSchema.ts";
import { validateRedesign } from "../src/suggest/redesign.ts";
import { chat } from "../src/agent/loop.ts";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import { model, tile } from "./fixtures.ts";

const makeProposal = (actions: unknown[]) => ({
  title: "Calibrate retention scale and benchmarks",
  reason: "Fit the retention axis and mark the 100% parity threshold and policy launch.",
  actions,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("format proposal action & validateRedesign", () => {
  it("parses and merges format properties onto an existing metric tile without clobbering existing format fields", () => {
    const spec = {
      title: "Retention overview",
      tiles: [
        tile({
          id: "retention",
          title: "Net retention",
          metrics: ["retention"],
          dimensions: ["month:sold_on"],
          chart: "line",
          format: { number: "percent", padding: 18 },
        }),
      ],
    };

    const raw = makeProposal([
      {
        type: "format",
        id: "retention",
        lineScale: "fit",
        palette: "editorial",
        targetValue: 1,
        targetLabel: "100% parity",
        annotations: [
          { at: "2026-06-01", label: "Annual plan policy", kind: "policy" },
          { at: "2026-08-01", label: "Usage tier launch", kind: "launch" },
        ],
        referenceLines: [{ label: "100% parity", value: 1 }],
      },
    ]);

    const parsed = proposalSchema.parse(raw);
    expect(parsed.actions[0]).toMatchObject({
      type: "format",
      id: "retention",
      lineScale: "fit",
      palette: "editorial",
      targetValue: 1,
      targetLabel: "100% parity",
    });

    const applied = applyProposal(spec, DEFAULT_CANVAS, raw, model);
    expect(applied.spec.tiles[0].format).toEqual({
      number: "percent",
      padding: 18,
      lineScale: "fit",
      palette: "editorial",
      targetValue: 1,
      targetLabel: "100% parity",
      annotations: [
        { at: "2026-06-01", label: "Annual plan policy", kind: "policy" },
        { at: "2026-08-01", label: "Usage tier launch", kind: "launch" },
      ],
      referenceLines: [{ label: "100% parity", value: 1 }],
    });
    expect(spec.tiles[0].format).toEqual({ number: "percent", padding: 18 });
  });

  it("rejects format actions targeting non-metric tiles", () => {
    const spec = {
      title: "Narrative",
      tiles: [
        tile({ id: "heading", kind: "heading", text: "Overview", metrics: [] }),
      ],
    };
    expect(() =>
      applyProposal(spec, DEFAULT_CANVAS, makeProposal([{ type: "format", id: "heading", lineScale: "fit" }]), model),
    ).toThrow(/Format changes require a metric tile/);
  });

  it("treats format upgrades as analytical improvements in validateRedesign and remains compatible with strictToolSchema", () => {
    const spec = {
      title: "Retention overview",
      tiles: [
        tile({
          id: "retention",
          title: "Net retention",
          metrics: ["retention"],
          dimensions: ["month:sold_on"],
          chart: "line",
        }),
      ],
    };

    const formatUpgrade = makeProposal([
      {
        type: "format",
        id: "retention",
        lineScale: "fit",
        targetValue: 1,
        targetLabel: "100% parity",
        annotations: [{ at: "2026-06-01", label: "Policy update", kind: "policy" }],
        referenceLines: [{ label: "100% parity", value: 1 }],
      },
    ]);

    expect(redesignToolSchema.parse(formatUpgrade).actions[0].type).toBe("format");
    const strictJson = strictToolSchema(z.toJSONSchema(redesignToolSchema, { reused: "inline" }));
    const formatBranch = strictJson.properties.actions.items.anyOf.find((s: any) => s.properties?.type?.const === "format");
    expect(formatBranch).toBeDefined();
    expect(formatBranch.required).toEqual(
      expect.arrayContaining(["type", "id", "lineScale", "palette", "targetValue", "targetLabel", "annotations", "referenceLines"]),
    );

    const validated = validateRedesign(spec, DEFAULT_CANVAS, formatUpgrade, model);
    expect(validated.spec.tiles[0].format).toMatchObject({
      lineScale: "fit",
      targetValue: 1,
      targetLabel: "100% parity",
      referenceLines: [{ label: "100% parity", value: 1 }],
    });

    // Empty format action combined with a title rename is still caught as wording-only
    expect(() =>
      validateRedesign(
        spec,
        DEFAULT_CANVAS,
        makeProposal([{ type: "rename", title: "New title" }, { type: "format", id: "retention" }]),
        model,
      ),
    ).toThrow(/only changes wording/);
  });
});

describe("blank-canvas redesign budget & structured agent trace", () => {
  it("grants max_iterations: 5 for blank-canvas redesigns and records a structured trace across 5 sequential turns", async () => {
    const blankActive = {
      spec: { title: "Untitled", tiles: [] },
      canvas: DEFAULT_CANVAS,
      selected: [],
      model,
    };

    const validBlankProposal = {
      title: "Executive Revenue & Retention",
      reason: "Checked 6 months of revenue and retention.",
      actions: [
        {
          type: "add",
          tile: {
            id: "rev-trend",
            kind: "metric",
            title: "Monthly Revenue",
            metrics: ["revenue"],
            dimensions: ["month:sold_on"],
            chart: "line",
            compare: "none",
            where: [],
            limit: 500,
            section: null,
            layout: { x: 24, y: 24, w: 600, h: 320 },
            format: { number: "currency", palette: "default" },
          },
        },
        {
          type: "format",
          id: "rev-trend",
          lineScale: "fit",
          targetValue: 150000,
          targetLabel: "Q3 Target",
          annotations: [{ at: "2026-06-01", label: "Enterprise launch", kind: "launch" }],
          referenceLines: [{ label: "Q3 Target", value: 150000 }],
        },
      ],
    };

    const providerRequests: any[] = [];
    const turnBlocks = [
      [{ type: "tool_use", id: "t-1", name: "describe_model", input: {} }],
      [{ type: "tool_use", id: "t-2", name: "profile_field", input: { base: "dim_users", fields: ["country"] } }],
      [{ type: "tool_use", id: "t-3", name: "query_metric", input: { metrics: ["revenue"], dimensions: ["month:sold_on"] } }],
      [
        {
          type: "tool_use",
          id: "t-4",
          name: "propose_canvas_changes",
          input: { ...validBlankProposal, actions: [{ type: "remove", id: "missing" }] },
        },
      ],
      [
        {
          type: "tool_use",
          id: "t-5",
          name: "propose_canvas_changes",
          input: validBlankProposal,
        },
      ],
    ];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (url.hostname === "api.anthropic.com") {
        const body = await req.json();
        providerRequests.push(body);
        const content = turnBlocks[providerRequests.length - 1] ?? [
          { type: "text", text: "Built the executive revenue dashboard." },
        ];
        const isTool = content.some((b: any) => b.type === "tool_use");
        return new Response(
          JSON.stringify({
            id: `msg-${providerRequests.length}`,
            type: "message",
            role: "assistant",
            model: "synthetic",
            content,
            stop_reason: isTool ? "tool_use" : "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.pathname === "/api/model") {
        return new Response(JSON.stringify(model), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/api/profile") {
        return new Response(
          JSON.stringify({ profiles: [{ field: "dim_users.country", type: "string", cardinality: 3, sample: ["US", "CA", "UK"] }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.pathname === "/api/query") {
        return new Response(
          JSON.stringify({
            columns: ["month", "revenue"],
            rows: Array.from({ length: 6 }, (_, i) => [`2026-0${i + 1}-01`, (i + 1) * 25000]),
            truncated: false,
            partial: { start: false, end: false },
            evidence: { rowsChecked: 6 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch URL: ${req.url}`);
    });

    const result = await chat(
      { provider: "anthropic", model: "synthetic", apiKey: "synthetic-key" },
      [],
      "Build an executive dashboard from scratch",
      {},
      blankActive,
      undefined,
      "redesign",
    );

    // Blank-canvas redesigns get max_iterations: 5 (all 5 tool turns completed within phase 1 without needing finalize phase)
    expect(providerRequests).toHaveLength(5);
    expect(providerRequests.every(r => r.tools.length > 1)).toBe(true);
    expect(result.proposal).toEqual(validBlankProposal);
    expect(result.trace).toEqual([
      {
        step: 1,
        tool: "describe_model",
        status: "ok",
        summary: "Described semantic model (3 tables, 8 metrics)",
      },
      {
        step: 2,
        tool: "profile_field",
        status: "ok",
        summary: "Profiled dim_users.country",
      },
      {
        step: 3,
        tool: "query_metric",
        status: "ok",
        rowsChecked: 6,
        summary: "Queried revenue by month:sold_on (6 rows checked)",
      },
      {
        step: 4,
        tool: "propose_canvas_changes",
        status: "rejected",
        summary: "Rejected proposal: The proposed tile missing no longer exists",
      },
      {
        step: 5,
        tool: "propose_canvas_changes",
        status: "ok",
        summary: "Proposed 2 canvas changes: Executive Revenue & Retention",
      },
    ]);
  });

  it("summarizes layout, dashboard, and rejected research tool calls in trace", async () => {
    const providerRequests: any[] = [];
    const turnBlocks = [
      [{ type: "tool_use", id: "t-1", name: "list_layouts", input: {} }],
      [{ type: "tool_use", id: "t-2", name: "list_dashboards", input: {} }],
      [{ type: "tool_use", id: "t-3", name: "get_dashboard", input: { id: "sales" } }],
      [{ type: "tool_use", id: "t-4", name: "query_metric", input: { metrics: ["unknown_metric"] } }],
    ];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (url.hostname === "api.anthropic.com") {
        const body = await req.json();
        providerRequests.push(body);
        const content = turnBlocks[providerRequests.length - 1] ?? [{ type: "text", text: "Done." }];
        const isTool = content.some((b: any) => b.type === "tool_use");
        return new Response(
          JSON.stringify({
            id: `msg-${providerRequests.length}`,
            type: "message",
            role: "assistant",
            model: "synthetic",
            content,
            stop_reason: isTool ? "tool_use" : "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.pathname === "/api/dashboards") {
        return new Response(JSON.stringify({ dashboards: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/api/dashboards/sales") {
        return new Response(JSON.stringify({ id: "sales", spec: { title: "Sales", tiles: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/api/query") {
        return new Response(JSON.stringify({ error: "Unknown metric" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${req.url}`);
    });

    const result = await chat(
      { provider: "anthropic", model: "synthetic", apiKey: "synthetic-key" },
      [],
      "Check dashboards",
      {},
    );

    expect(result.trace).toEqual([
      { step: 1, tool: "list_layouts", status: "ok", summary: "Listed layout templates" },
      { step: 2, tool: "list_dashboards", status: "ok", summary: "Listed dashboards" },
      { step: 3, tool: "get_dashboard", status: "ok", summary: "Loaded dashboard sales" },
      { step: 4, tool: "query_metric", status: "rejected", rowsChecked: null, summary: "Rejected query for unknown_metric" },
    ]);
  });
});
