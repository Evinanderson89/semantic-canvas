import { conn } from "./fixtures.ts";
import { expect, it } from "vitest";
import { duckglueAdapter } from "../src/semantic/duckglue.ts";
import { libraryStarters } from "../src/library/setup.ts";
import { showcaseStarters } from "../src/library/showcase.ts";
import { compileTile } from "../src/compiler/compile.ts";
import { dashboardSchema } from "../src/compiler/schema.ts";
import { validateDashboard } from "../src/app/filters.ts";
import { overlaps } from "../src/canvas/geometry.ts";
import { fitStarter } from "../src/library/fitStarter.ts";

it("offers distinct, valid compositions whose governed queries compile without overlaps", async () => {
  const model = await duckglueAdapter.load("sample-data/warehouse.yaml");
  if (!model) throw new Error("The bundled sample model is required for showcase validation");
  const curated = showcaseStarters();
  expect(libraryStarters(model)).toHaveLength(10);
  const kinds = new Set<string>();
  for (const [name, spec] of Object.entries(curated)) {
    expect(dashboardSchema.safeParse(spec).success,name).toBe(true);
    expect(validateDashboard(model,spec),name).toEqual([]);
    for (const [i,t] of spec.tiles.entries()) {
      expect(spec.tiles.slice(i+1).some(other => overlaps(t.layout,other.layout)),`${name}: ${t.id}`).toBe(false);
      if (t.kind === "metric") { expect(() => compileTile(model,conn,t),`${name}: ${t.id}`).not.toThrow(); kinds.add(t.chart!); }
    }
    const starter=libraryStarters(model).find(d=>d.name===name)!;
    const fitted=fitStarter(spec,starter.canvas,920);
    expect(fitted.spec.tiles.map(t=>t.chart)).toEqual(spec.tiles.map(t=>t.chart));
    expect(fitted.spec.tiles.every(t=>t.layout.x+t.layout.w<=920),name).toBe(true);
  }
  expect([...kinds]).toEqual(expect.arrayContaining(["waterfall","map","scatter","heatmap","smallMultiples","combo","funnel","donut","areaStacked","barStacked"]));
});
