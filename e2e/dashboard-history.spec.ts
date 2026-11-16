import { test, expect } from "@playwright/test";
import { openStarter } from "./library-helpers.ts";
import { showcaseStarters } from "../src/library/showcase.ts";

test.describe("saved date labels", () => {
  test.use({ timezoneId: "America/New_York", locale: "en-US" });
  test("shows known dates in the viewer timezone and identifies unknown legacy dates", async ({ page }) => {
    await page.route("**/api/dashboards", route => route.request().method() === "GET"
      ? route.fulfill({ json: { dashboards: [
        { id: "known-time", name: "Known save time", updated_at: "2026-01-15T15:30:00.000Z" },
        { id: "unknown-time", name: "Older dashboard", updated_at: null },
      ] } }) : route.continue());
    await page.goto("/");
    await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Saved dashboards" });
    await expect(dialog.getByRole("button", { name: /Known save time/ })).toContainText("Jan 15, 2026, 10:30 AM");
    await expect(dialog.getByRole("button", { name: /Older dashboard/ })).toContainText("Earlier save · time zone unavailable");
    await expect(dialog).not.toContainText("Invalid Date");
  });
});
test("edit and preview are explicit and preview does not dirty a saved dashboard", async ({ page, request }, info) => {
  await page.goto("/"); await openStarter(page,"SaaS overview");
  const mode=page.getByLabel("Dashboard mode",{exact:true});
  await expect(mode).toContainText("EDIT MODE"); await expect(mode).toContainText("Not saved yet");
  const saved=page.waitForResponse(r=>r.url().endsWith("/api/dashboards") && r.request().method()==="POST");
  await page.getByRole("button",{name:"Save dashboard",exact:true}).click();
  const result=await (await saved).json();
  await expect(page.locator(".save-status")).toHaveText("Saved");
  await mode.getByRole("button",{name:"Preview dashboard",exact:true}).click();
  await expect(mode).toContainText("PREVIEW"); await expect(mode).toContainText("does not publish");
  await expect(page.locator(".save-status")).toHaveText("Saved");
  await expect(page.getByLabel("Period",{exact:true})).toBeDisabled();
  await expect(page.getByRole("button",{name:"Smart arrange",exact:true})).toHaveCount(0);
  expect((await (await request.get(`/api/dashboards/${result.id}`)).json()).canvas.locked).toBe(false);
  await page.screenshot({path:info.outputPath("dashboard-preview-mode.png")});
  await mode.getByRole("button",{name:"Edit dashboard",exact:true}).click();
  await expect(page.getByRole("button",{name:"Smart arrange",exact:true})).toBeVisible();
  await expect(page.locator(".save-status")).toHaveText("Saved");
  const modeHeight=(await mode.boundingBox())!.height;
  await page.getByRole("group",{name:"Ending MRR",exact:true}).click({position:{x:12,y:12}});
  await expect(page.locator(".inspector")).toBeVisible();
  expect((await mode.boundingBox())!.height).toBe(modeHeight);
});

test("saved versions preview and restore as a new draft while keeping unsaved work recoverable",async ({page,request},info)=>{
  const id=crypto.randomUUID();
  const spec={title:`Versioned design ${id}`,tiles:[{id:"note",kind:"text",text:"Original decision",metrics:[],dimensions:[],layout:{x:24,y:24,w:500,h:160}}]};
  expect((await request.post("/api/dashboards",{data:{id,spec}})).ok()).toBe(true);
  expect((await request.post("/api/dashboards",{data:{id,revision:1,spec:{...spec,tiles:[{...spec.tiles[0],text:"Revised decision"}]}}})).ok()).toBe(true);
  await page.goto("/"); await page.getByRole("button",{name:"Open saved dashboard",exact:true}).click();
  await page.getByRole("dialog").getByRole("button",{name:spec.title,exact:false}).click();
  await page.locator(".note-text").fill("Unsaved third idea"); await page.locator(".note-text").press("Tab");
  await page.getByRole("button",{name:"Version history",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"Version history"});
  await dialog.getByRole("button",{name:/Version 1/}).click();
  await expect(dialog.getByRole("img",{name:"Layout of version 1"})).toBeVisible();
  await page.screenshot({path:info.outputPath("dashboard-version-history.png")});
  await dialog.getByRole("button",{name:"Restore as draft",exact:true}).click();
  const notice=page.locator(".document-notice");
  await expect(notice).toHaveAttribute("role","status");
  await expect(notice).toContainText("restored as an unsaved draft");
  await expect(notice.getByRole("button",{name:"Download backup",exact:true})).toHaveCount(0);
  await notice.getByRole("button",{name:"Dismiss notification",exact:true}).focus();
  await page.keyboard.press("Enter");
  await expect(notice).toHaveCount(0);
  await expect(page.getByRole("button",{name:"Save dashboard",exact:true})).toBeFocused();
  await expect(page.locator(".note-text")).toHaveText("Original decision");
  await expect(page.locator(".save-status")).toHaveText("Unsaved changes");
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem("sc:drafts")??"[]").some((d:any)=>d.spec.tiles.some((t:any)=>t.text==="Unsaved third idea")))).toBe(true);
  const saved=page.waitForResponse(r=>r.url().endsWith("/api/dashboards") && r.request().method()==="POST");
  await page.getByRole("button",{name:"Save dashboard",exact:true}).click(); expect((await(await saved).json()).revision).toBe(3);
  const history=await(await request.get(`/api/dashboards/${id}/versions`)).json(); expect(history.versions.map((v:any)=>v.revision)).toEqual([3,2,1]);
  const retained=await(await request.get(`/api/dashboards/${id}/versions/2`)).json(); expect(retained.spec.tiles[0].text).toBe("Revised decision");
});

for(const [name,spec] of Object.entries(showcaseStarters())) test(`showcase: ${name} renders its governed visual mix`,async({page,request},info)=>{
  for(const tile of spec.tiles.filter(t=>t.kind==="metric")) {
    const response=await request.post("/api/query",{headers:{"x-sc-principal":"admin"},data:{metrics:tile.metrics,dimensions:tile.dimensions,where:tile.where,limit:tile.limit,compare:tile.compare}});
    expect(response.ok(),`${name}: ${tile.title}: ${await response.text()}`).toBe(true);
    const result=await response.json(); expect(result.rows.length,`${name}: ${tile.title}`).toBeGreaterThan(0); expect(result.truncated).not.toBe(true);
    if(tile.id === "addon-share" || tile.id === "revenue-share") {
      expect(result.rows.length).toBeLessThanOrEqual(5);
      const detailResponse = await request.post("/api/query", { headers:{"x-sc-principal":"admin"}, data:{metrics:tile.metrics, dimensions:["dim_plans.plan_name"], limit:1000} });
      expect(detailResponse.ok()).toBe(true);
      const detail = await detailResponse.json();
      const sum = (r: {columns:string[];rows:unknown[][]}) => r.rows.reduce((total,row) => total + Number(row[r.columns.indexOf(tile.metrics[0])]),0);
      expect(sum(result)).toBeCloseTo(sum(detail), 6);
      expect(detail.rows.length).toBeGreaterThan(result.rows.length);
    }
  }
  await page.goto("/"); await openStarter(page,name);
  await expect(page.locator(".tile .err")).toHaveCount(0);
  await expect(page.locator(".tile figure")).toHaveCount(spec.tiles.filter(t=>t.kind==="metric" && t.chart!=="kpi" && t.chart!=="table").length);
  await expect(page.locator(".tile .err")).toHaveCount(0);
  if(name === "SaaS overview") await expect(page.getByRole("group", { name: "Net vs. gross retention", exact: true }).locator("figcaption")).toContainText("Y-axis fitted to data");
  if(name === "Marketing performance") {
    const scatter=page.getByRole("group",{name:"Channel CPC vs. click-through rate",exact:true}).locator("figure");
    await expect(scatter).toContainText("email"); await expect(scatter).toContainText("paid_search");
  }
  if(name === "Subscription add-ons" || name === "Subscriptions") {
    const title = name === "Subscriptions" ? "Plan scale vs. revenue per subscriber" : "Attached terms vs. incremental MRR";
    const scatter = page.getByRole("group", {name:title,exact:true}).locator("figure");
    const label = scatter.locator('g[aria-label="y-axis label"] text');
    await expect(label).toBeVisible();
    const titleBox = (await label.boundingBox())!;
    const tickBoxes = await scatter.locator('g[aria-label="y-axis tick label"] text').evaluateAll(nodes => nodes.map(node => {
      const r = node.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height};
    }));
    expect(tickBoxes.length).toBeGreaterThan(1);
    for(const tick of tickBoxes) expect(titleBox.x + titleBox.width).toBeLessThan(tick.x - 3);
  }
  for (const tile of spec.tiles.filter(t => t.chart === "heatmap")) {
    const figure = page.getByRole("group", {name:tile.title!,exact:true}).locator("figure");
    const svg = figure.locator('svg:has(g[aria-label="cell"])');
    const frame = (await svg.boundingBox())!;
    const ticks = await svg.locator('g[aria-label="x-axis tick label"] text').evaluateAll(nodes => nodes.map(node => {
      const r = node.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height};
    }));
    expect(ticks.length).toBeGreaterThan(0);
    for (const tick of ticks) {
      expect(tick.y + tick.height).toBeLessThanOrEqual(frame.y + frame.height);
      expect(tick.x).toBeGreaterThanOrEqual(frame.x);
    }
    if(tile.id === "movement-matrix") {
      await expect(figure.locator("figcaption")).toContainText("neutral color marks zero");
      const cells = figure.locator('g[aria-label="cell"] rect');
      const loss = cells.filter({has:page.locator("title",{hasText:"churn"})}).first();
      const gain = cells.filter({has:page.locator("title",{hasText:"expansion"})}).first();
      expect(await loss.getAttribute("fill")).not.toEqual(await gain.getAttribute("fill"));
    }
  }
  {
    await page.locator(".canvas-scroll").evaluate(el=>el.scrollTo(0,0));
    await page.screenshot({path:info.outputPath("showcase-editor.png")});
    await page.getByRole("button",{name:"Preview dashboard",exact:true}).click();
    await page.setViewportSize({width:1440,height:1900});
    await page.locator(".canvas-surface").screenshot({path:info.outputPath("showcase-full.png")});
  }
});

test("history distinguishes data scope from layout and story changes before restoring", async ({ page, request }, info) => {
  const id = crypto.randomUUID(), title = `Version comparison ${id}`;
  const first = { title, tiles: [{ id: "metric", title: "Revenue trend", metrics: ["new_mrr"], dimensions: ["month:movement_date"], chart: "line", layout: { x: 24, y: 24, w: 650, h: 360 } }] };
  const second = { ...first, tiles: [{ ...first.tiles[0], title: "Revenue by country", dimensions: ["dim_users.country"], chart: "barH", layout: { x: 24, y: 24, w: 750, h: 360 } }] };
  expect((await request.post("/api/dashboards", { data: { id, spec: first } })).ok()).toBe(true);
  expect((await request.post("/api/dashboards", { data: { id, revision: 1, spec: second } })).ok()).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(title) }).click();
  await page.getByRole("button", { name: "Version history", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Version history" });
  await expect(dialog).toContainText("No authored changes");
  await dialog.getByRole("button", { name: /Version 1/ }).click();
  const changes = dialog.getByLabel("Changes if restored");
  const scope = changes.locator("details").filter({ has: page.locator("summary", { hasText: "Data and scope" }) });
  await expect(scope).toHaveAttribute("open");
  await expect(scope).toContainText("Dimensions and time grain");
  await expect(scope).toContainText("dim_users.country");
  await expect(scope).toContainText("month:movement_date");
  const visual = changes.locator("details").filter({ has: page.locator("summary", { hasText: "Layout and appearance" }) });
  await visual.locator("summary").click();
  await expect(visual).toContainText("Visualization");
  await expect(visual).toContainText("Horizontal bar");
  await expect(visual).toContainText("Position and size");
  await changes.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("dashboard-version-changes.png") });
  await dialog.getByRole("button", { name: /Version 2/ }).click();
  await expect(changes).toContainText("No authored changes");
  await expect(changes.locator("details")).toHaveCount(0);
});
