import { COUNTRIES, toFeatureId } from "../src/charts/geo.ts";
import { beforeAll, expect, it } from 'vitest';
import { duckglueAdapter } from '../src/semantic/duckglue.ts';
import type { Model } from '../src/semantic/model.ts';
import { demoDashboard } from '../src/suggest/demo.ts';
import { matchModel } from '../src/suggest/match.ts';
import { applyBestLayout } from '../src/canvas/layouts.ts';
import { DEFAULT_FORMAT, makeAxisFormatter } from '../src/format/format.ts';
import { kpiSummary } from '../src/app/kpiSummary.ts';
import { grainReviewKey, worthwhileCoarsening } from '../src/suggest/reviewChecks.ts';
let model: Model;
beforeAll(async () => { model = (await duckglueAdapter.load('sample-data/warehouse.yaml'))!; });
it('ranks churn ahead of acquisition for losing customers', () => {
 const matched = matchModel(model, 'where are we losing customers').metrics;
 expect(matched[0].metric.name).toMatch(/churn/);
});
it('retains the full two-year daily starter series', () => {
 expect(demoDashboard().tiles.find(t=>t.id==='d2')!.limit).toBeGreaterThan(730);
});
it('orders headline KPIs by semantic importance without moving pinned content', () => {
 const draft=demoDashboard();
 const arranged=applyBestLayout(draft.tiles,1120,model).tiles;
 const ending=arranged.find(t=>t.id==='d1')!, nrr=arranged.find(t=>t.id==='d5')!;
 expect(ending.layout.y).toBe(nrr.layout.y); expect(ending.layout.x).toBeLessThan(nrr.layout.x);
 const pinned={...draft.tiles[0],pinned:true};
 expect(applyBestLayout([pinned,...draft.tiles.slice(1)],1120,model).tiles.find(t=>t.id===pinned.id)?.layout).toEqual(pinned.layout);
});
it('expresses a rate change in percentage points, including a zero baseline', () => {
 const series=[{x:'2026-08-01',y:1.028}];
 expect(kpiSummary(series,'prior','month',1.044,true).delta).toBeCloseTo(-1.6);
 expect(kpiSummary(series,'prior','month',0,true).delta).toBeCloseTo(102.8);
 expect(kpiSummary(series,'prior','month',1.044).delta).toBeCloseTo(-0.01532567);
 expect(kpiSummary(series,'prior','month',null,true).delta).toBeNull();
});
it('uses one currency scale throughout an axis', () => {
 const fmt=makeAxisFormatter({...DEFAULT_FORMAT,number:'currency'},[0,5000,10000,20000]);
 expect([0,5000,10000,20000].map(fmt)).toEqual(['$0k','$5k','$10k','$20k']);
 expect(makeAxisFormatter({...DEFAULT_FORMAT,number:'currency'},[-20000,5000])(-5000)).toBe('-$5k');
});
it('remembers accepted grain across layout edits but rechecks changed query or data', () => {
 const tile=demoDashboard().tiles.find(t=>t.id==='d2')!;
 const weekly={...tile,dimensions:['week:fct_web_sessions.session_date']};
 const key=grainReviewKey(weekly,'scope1');
 expect(grainReviewKey({...weekly,layout:{x:0,y:0,w:600,h:300}} as typeof weekly,'scope1')).toBe(key);
 expect(grainReviewKey({...weekly,dimensions:['month:fct_web_sessions.session_date']},'scope1')).not.toBe(key);
 expect(grainReviewKey(weekly,'scope2')).not.toBe(key);
});

it('does not recommend another grain for a marginal improvement or too few periods', () => {
 const before=[{measure:'sessions',score:0.095}];
 expect(worthwhileCoarsening(before,[{measure:'sessions',score:0.084}],24)).toBe(false);
 expect(worthwhileCoarsening([{measure:'sessions',score:0.1138869}],before,104)).toBe(true);
 expect(worthwhileCoarsening(before,[],8)).toBe(false);
 expect(worthwhileCoarsening(before,[],24)).toBe(false);
 expect(worthwhileCoarsening(before,[{measure:'sessions',score:0}],24)).toBe(true);
});

it('joins every sample country code to the atlas, including leading zeroes', () => {
 for (const code of ['US','GB','IN','CA','DE','AU','BR','FR','NL','SE']) {
  const id=toFeatureId(code);
  expect(COUNTRIES.features.some((f: {id: string})=>String(f.id)===id),code).toBe(true);
 }
 expect(toFeatureId('AU')).toBe(toFeatureId('Australia'));
 expect(toFeatureId(36)).toBe(toFeatureId('036'));
 expect(toFeatureId('BR')).toBe(toFeatureId('Brazil'));
});
