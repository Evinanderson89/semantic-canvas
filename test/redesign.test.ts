import { expect, it } from "vitest";
import { validateRedesign } from "../src/suggest/redesign.ts";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import { model, tile } from "./fixtures.ts";
import { applyProposal } from "../src/canvas/proposals.ts";

const source = () => ({ title: "Revenue", tiles: [tile({ id: "revenue", title: "Our revenue", chart: "bar", dimensions: ["dim_users.country"], where: [{ id: "region", field: "dim_users.country", source: "dimension" as const, mode: "discrete" as const, values: ["US"] }] })] });
const proposal = (actions: unknown[]) => ({ title: "Understand the trend", reason: "Compare revenue through time instead of an isolated category.", actions });

it("redesigns an existing chart query and visualization while preserving filters and the original document", () => {
  const spec = source();
  const result = validateRedesign(spec, DEFAULT_CANVAS, proposal([{ type: "query", id: "revenue", dimensions: ["month:sold_on"], compare: "prior" }, { type: "chart", id: "revenue", chart: "line" }]), model);
  expect(result.spec.tiles[0]).toMatchObject({ dimensions: ["month:sold_on"], compare: "prior", chart: "line", where: spec.tiles[0].where, title: "Our revenue" });
  expect(spec.tiles[0].chart).toBe("bar");
  expect(spec.tiles[0].dimensions).toEqual(["dim_users.country"]);
});

it("rejects invented metrics, incompatible dimensions, and headline cards with categorical queries", () => {
  expect(() => validateRedesign(source(), DEFAULT_CANVAS, proposal([{ type: "query", id: "revenue", metrics: ["invented"] }]), model)).toThrow(/unknown metric/);
  expect(() => validateRedesign(source(), DEFAULT_CANVAS, proposal([{ type: "query", id: "revenue", dimensions: ["invented"] }]), model)).toThrow();
  expect(() => validateRedesign(source(), DEFAULT_CANVAS, proposal([{ type: "query", id: "revenue", dimensions: [] }, { type: "chart", id: "revenue", chart: "kpi" }, { type: "query", id: "revenue", dimensions: ["dim_users.country"] }]), model)).toThrow(/headline/);
});

it("requires a substantive change even if a title-only proposal includes an unchanged query", () => {
  expect(() => validateRedesign(source(), DEFAULT_CANVAS, proposal([{ type: "rename", title: "Better title" }]), model)).toThrow(/Wording/);
  expect(() => validateRedesign(source(), DEFAULT_CANVAS, proposal([{ type: "rename", title: "Better title" }, { type: "query", id: "revenue", dimensions: ["dim_users.country"] }]), model)).toThrow(/only changes wording/);
});

it("can resize and group a chart, but preserves pinned sections and rejects new collisions", () => {
  const spec = source();
  const heading = tile({ id: "section", kind: "heading", metrics: [], text: "Our question", layout: { x: 24, y: 24, w: 600, h: 48 } });
  const result = applyProposal(spec, DEFAULT_CANVAS, proposal([{ type: "add", tile: heading }, { type: "place", id: "revenue", section: "section", layout: { x: 24, y: 100, w: 900, h: 360 } }]), model);
  expect(result.spec.tiles[0]).toMatchObject({ section: "section", layout: { w: 900, h: 360 } });
  result.spec.tiles[0].pinned = true;
  expect(() => applyProposal(result.spec, DEFAULT_CANVAS, proposal([{ type: "place", id: "section", layout: { x: 24, y: 500, w: 600, h: 48 } }]), model)).toThrow(/pinned/);
  expect(() => validateRedesign(spec, DEFAULT_CANVAS, proposal([{ type: "add", tile: { ...spec.tiles[0], id: "duplicate" } }]), model)).toThrow(/overlapping/);
  expect(() => validateRedesign(spec, DEFAULT_CANVAS, proposal([{ type: "place", id: "revenue", layout: { x: DEFAULT_CANVAS.width, y: 100, w: 900, h: 360 } }]), model)).toThrow(/canvas width/);
});
