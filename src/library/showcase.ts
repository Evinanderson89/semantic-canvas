import type { ChartKind, DashboardSpec, TileSpec } from "../compiler/spec.ts";

// Each composition starts with a business question, not a chart-type checklist.
// All marks come from governed sample metrics. No result values or conclusions are hard-coded.
const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const period = (field: string, start = "2026-03-01", end = "2026-08-31") => [{ id: `window-${field}`, source: "dimension" as const, field, mode: "range" as const, min: start, max: end }];
const chart = (id: string, title: string, metrics: string[], dimensions: string[], kind: ChartKind, layout: TileSpec["layout"], date?: string, palette = "default"): TileSpec => ({
  id, title, kind: "metric", metrics, dimensions, chart: kind, layout, limit: 1000,
  ...(date ? { where: period(date) } : {}), format: { palette, padding: 18 },
});
const heading = (id: string, title: string, y = 24): TileSpec => ({ id, kind: "heading", title, metrics: [], dimensions: [], layout: box(24,y,1072,66), format: { textSize: 34, background: false, border: false } });
const note = (id: string, text: string, layout = box(24,94,1072,76)): TileSpec => ({ id, kind: "text", text, metrics: [], dimensions: [], layout, format: { textSize: 16, background: false, border: false } });
const kpi = (id: string, title: string, metric: string, x: number, date?: string): TileSpec => ({ ...chart(id,title,[metric],date ? [`month:${date}`] : [],"kpi",box(x,192,344,168),date), ...(date ? { compare: "prior" as const } : {}) });
const pack = (title: string, question: string, copy: string, tiles: TileSpec[]): DashboardSpec => ({ title, description: question, tiles: [heading("headline", question), note("reading-guide", copy), ...tiles] });
const M = "fct_saas_monthly.month", R = "fct_mrr_movements.movement_date", W = "fct_web_sessions.session_date", A = "fct_marketing_spend.spend_date", U = "dim_users.signup_date", E = "fct_events.event_date";

export const showcaseStarters = (): Record<string, DashboardSpec> => ({
  "SaaS overview": {
    ...pack("SaaS overview", "Growth, with retention in view.",
      "SAMPLE WAREHOUSE · MARCH–AUGUST 2026\nStart with August’s position. Separate the revenue trend from retention, then inspect the signed movements behind the change.", [
      kpi("ending-mrr","Ending MRR","ending_mrr",24,M), kpi("retention","Net revenue retention","nrr",388,M), kpi("acquisition-cost","Customer acquisition cost","cac",752,M),
      {
        ...chart("revenue-trend","Recurring revenue · monthly closing balance",["ending_mrr"],[`month:${M}`],"area",box(24,384,640,350),M,"cool"),
        format: {
          palette: "cool",
          padding: 18,
          targetValue: 180000,
          targetLabel: "Q3 Goal · $180k",
          annotations: [
            { at: "2026-05-01", label: "May 12 · Enterprise tier cutover", kind: "policy" },
          ],
        },
      },
      { ...chart("retention-trend","Net vs. gross retention",["nrr","grr"],[`month:${M}`],"line",box(688,384,408,350),M,"cool"), format: { palette: "cool", padding: 18, lineScale: "fit", targetValue: 1, targetLabel: "100% parity" } },
      heading("drivers","What is driving the change?",762),
      { ...chart("revenue-bridge","August MRR movements · signed contribution",["net_new_mrr"],["fct_mrr_movements.movement_type"],"waterfall",box(24,852,640,360),R), where:period(R,"2026-08-01") },
      chart("plan-mix","Active base-subscription MRR by plan",["mrr"],["dim_plans.plan_name"],"barH",box(688,852,408,360),undefined,"warm"),
      note("scope-note","READ THE SCOPE · Retention excludes new business. The movement bridge shows August changes; the plan ranking shows current active base subscriptions, excluding add-ons.",box(24,1232,1072,86)),
    ]),
    tabs: [{
      id: "main",
      title: "Overview",
      brief: {
        question: "Is recurring revenue growth durable, and what drove August’s +$25.5k net gain?",
        takeaway: "August ending MRR reached $202.8k (+14.4% MoM, +$22.8k above the $180k Q3 goal) while net revenue retention held above parity at 102.8%. Expansion and new enterprise tiers after the May 12 packaging cutover outweighed gross churn.",
        nextStep: "Inspect the August MRR movement bridge and active plan mix before finalizing Q4 enterprise expansion targets.",
      },
    }],
  },
  "MRR movements": pack("MRR movements", "See what adds—and erodes—revenue.",
    "SAMPLE WAREHOUSE · MARCH–AUGUST 2026\nA contribution bridge, a monthly mix and a movement heatmap reveal different parts of the same revenue story. Losses keep their negative sign.", [
    kpi("net-new","Net new MRR","net_new_mrr",24,R), kpi("gross-new","Gross additions","gross_new_mrr",388,R), kpi("lost","Lost MRR","lost_mrr",752,R),
    chart("bridge","Six-month net MRR contribution",["net_new_mrr"],["fct_mrr_movements.movement_type"],"waterfall",box(24,384,1072,360),R),
    chart("monthly-mix","Monthly movement mix",["net_new_mrr"],[`month:${R}`,"fct_mrr_movements.movement_type"],"barStacked",box(24,768,640,350),R),
    chart("plan-contribution","Net contribution by plan",["net_new_mrr"],["dim_plans.plan_name"],"barH",box(688,768,408,350),R,"cool"),
    chart("movement-matrix","When did each movement contribute?",["net_new_mrr"],[`month:${R}`,"fct_mrr_movements.movement_type"],"heatmap",box(24,1142,1072,350),R),
    note("scope-note","The bridge is a change in MRR over the selected window, not an ending MRR balance. The KPI cards show the latest month within that window.",box(24,1516,1072,72)),
  ]),
  "Subscriptions": pack("Subscriptions", "Understand the shape of the subscriber base.",
    "SAMPLE WAREHOUSE · CURRENT ACTIVE SUBSCRIPTIONS\nCompare revenue mix, subscriber volume and revenue per subscriber. These are current active terms, not historical subscription balances.", [
    kpi("mrr","Active base MRR","mrr",24), kpi("subscribers","Paying subscribers","paying_subscribers",388), kpi("arpu","MRR per subscriber","arpu",752),
    chart("revenue-share","Revenue mix by plan tier",["mrr"],["dim_plans.plan_tier"],"donut",box(24,384,408,380),undefined,"cool"),
    chart("subscriber-mix","Paying subscribers by plan",["paying_subscribers"],["dim_plans.plan_name"],"barH",box(456,384,640,380)),
    chart("plan-economics","Plan scale vs. revenue per subscriber",["paying_subscribers","arpu"],["dim_plans.plan_name"],"scatter",box(24,788,640,360)),
    chart("plan-detail","The numbers behind each plan",["paying_subscribers","mrr","arpu"],["dim_plans.plan_name"],"table",box(688,788,408,360)),
    note("scope-note","Each point is a plan, not a customer. Plan associations describe the current mix; they do not establish what caused revenue or churn.",box(24,1172,1072,72)),
  ]),
  "Subscription add-ons": pack("Subscription add-ons", "Find the expansion products that matter.",
    "SAMPLE WAREHOUSE · CURRENT ACTIVE ADD-ON TERMS\nRead product contribution first, then inspect the plan–product matrix. An attached term is not a unique customer.", [
    chart("addon-products","Active add-on MRR by product",["addon_mrr"],["fct_subscription_addons.addon_name"],"barH",box(24,192,640,350),undefined,"warm"),
    chart("addon-share","Add-on revenue mix by plan tier",["addon_mrr"],["dim_plans.plan_tier"],"donut",box(688,192,408,350),undefined,"cool"),
    chart("addon-matrix","Where products earn their revenue",["addon_mrr"],["fct_subscription_addons.addon_name","dim_plans.plan_name"],"heatmap",box(24,566,1072,380)),
    chart("addon-scale","Attached terms vs. incremental MRR",["addons_attached","addon_mrr"],["dim_plans.plan_name"],"scatter",box(24,970,640,340)),
    chart("addon-count","Active attached terms by product",["addons_attached"],["fct_subscription_addons.addon_name"],"barH",box(688,970,408,340),undefined,"warm"),
  ]),
  "Marketing performance": pack("Marketing performance", "Balance acquisition scale and efficiency.",
    "SAMPLE WAREHOUSE · MARCH–AUGUST 2026\nSpend shows scale; click-through rate and CPC show efficiency. Impression and click counts are advertising events, not a unique-person conversion funnel.", [
    kpi("spend","Marketing spend","marketing_spend",24,A), kpi("ctr","Click-through rate","click_through_rate",388,A), kpi("cpc","Cost per click","cost_per_click",752,A),
    chart("spend-efficiency","Monthly spend and click-through rate",["marketing_spend","click_through_rate"],[`month:${A}`],"combo",box(24,384,640,360),A),
    chart("paid-stages","Impressions → clicks · event counts",["ad_impressions","ad_clicks"],[],"funnel",box(688,384,408,360),A,"cool"),
    chart("channel-efficiency","Channel CPC vs. click-through rate",["cost_per_click","click_through_rate"],["fct_marketing_spend.channel"],"scatter",box(24,768,520,350),A),
    chart("spend-matrix","Spend concentration by month and channel",["marketing_spend"],[`month:${A}`,"fct_marketing_spend.channel"],"heatmap",box(568,768,528,350),A,"warm"),
    note("scope-note","The combo uses separate, labeled currency and percentage axes. Compare channel economics alongside volume before changing budget; these charts do not establish causation.",box(24,1142,1072,86)),
  ]),
  "Web traffic": pack("Web traffic", "See which channels move the audience.",
    "SAMPLE WAREHOUSE · MARCH–AUGUST 2026\nSmall multiples give each acquisition channel its own panel. Use the channel–site matrix to find where that traffic lands.", [
    kpi("sessions","Web sessions","web_sessions",24,W), kpi("conversion","Session signup conversion","signup_conversion_rate",388,W), kpi("views","Pageviews","pageviews",752,W),
    chart("channel-trends","Six channels. One shared timeline.",["web_sessions"],[`month:${W}`,"fct_web_sessions.channel"],"smallMultiples",box(24,384,1072,440),W,"cool"),
    chart("site-mix","Sessions by destination site",["web_sessions"],["fct_web_sessions.source_site"],"barH",box(24,848,408,360),W),
    chart("channel-site","Which channels reach each site?",["web_sessions"],["fct_web_sessions.source_site","fct_web_sessions.channel"],"heatmap",box(456,848,640,360),W),
    note("scope-note","Conversion is the share of sessions that ended in a signup. A visitor may have multiple sessions; do not interpret this as a unique-person conversion rate.",box(24,1232,1072,76)),
  ]),
  "Users": pack("Users", "Locate growth. Understand its mix.",
    "SAMPLE WAREHOUSE · MARCH–AUGUST 2026\nMap signup volume, compare acquisition sources over time and inspect the platform mix. The map encodes counts, not population-adjusted penetration.", [
    chart("signup-map","Where new accounts come from",["new_signups"],["dim_users.country"],"map",box(24,192,688,420),U,"cool"),
    chart("platform-mix","First-session platform mix",["new_signups"],["dim_users.device_platform"],"donut",box(736,192,360,420),U),
    chart("acquisition-mix","The changing acquisition mix",["new_signups"],[`month:${U}`,"dim_users.signup_source"],"areaStacked",box(24,636,688,370),U),
    chart("country-ranking","Country comparison · signup counts",["new_signups"],["dim_users.country"],"barH",box(736,636,360,470),U),
    note("scope-note","A geographic comparison needs both location and magnitude. Use the ranking to compare countries whose area on the map differs greatly.",box(24,1030,688,76)),
  ]),
  "Events & engagement": pack("Events & engagement", "Discover how people use the product.",
    "SAMPLE WAREHOUSE · MARCH–AUGUST 2026\nCompare activity across platforms and event types. Event volume measures usage frequency; active users measure distinct people within each query group.", [
    kpi("active-users","Active users","active_users",24,E), kpi("event-count","Events","event_count",388,E), kpi("entries","Entries created","entries_created",752,E),
    chart("engagement-matrix","Event types × platforms",["event_count"],["fct_events.event_name","dim_users.device_platform"],"heatmap",box(24,384,640,390),E,"cool"),
    chart("platform-volume","Entries created by platform",["entries_created"],["dim_users.device_platform"],"barH",box(688,384,408,390),E),
    chart("activity-mix","Monthly event volume by platform",["event_count"],[`month:${E}`,"dim_users.device_platform"],"barStacked",box(24,798,640,360),E),
    chart("activity-share","Share of recorded events",["event_count"],["dim_users.device_platform"],"donut",box(688,798,408,360),E),
    note("scope-note","Distinct active users are not additive across months. The stacked chart deliberately uses event counts, which can be summed across platforms.",box(24,1182,1072,76)),
  ]),
});
