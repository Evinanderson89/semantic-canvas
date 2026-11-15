import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

for (const example of ["line", "dualLine", "area", "combo", "smallMultiples", "areaStacked"] as const) test(`${example} breaks at a missing declared month without inventing values`, async ({page}, info) => {
  const kind = example === "dualLine" ? "line" : example;
  const segmented = kind === "smallMultiples";
  const metrics = example === "dualLine" ? ["new_mrr","new_paying_customers"] : kind === "combo" || kind === "areaStacked" ? ["new_mrr","expansion_mrr"] : ["new_mrr"];
  const columns = ["movement_date_month", ...(segmented ? ["country"] : []), ...metrics];
  const rows = ["2026-01-01","2026-03-01","2026-04-01"].map((date,i) => [date, ...(segmented ? ["US"] : []), ...metrics.map((_,m) => (i+1)*100 + m*10)]);
  await page.route("**/api/query", route => route.fulfill({json:{columns,rows,ms:1}}));
  const title = `Missing month · ${example} · ${crypto.randomUUID().slice(0,8)}`;
  const saved = await page.request.post("/api/dashboards", {data:{id:crypto.randomUUID(),spec:{title,tiles:[{
    id:"trend",title:"Revenue across observed months",chart:kind,metrics,
    dimensions:["month:fct_mrr_movements.movement_date",...(segmented ? ["dim_users.country"] : [])],
    layout:{x:24,y:24,w:900,h:480},
  }]}}});
  expect(saved.ok(),await saved.text()).toBe(true);
  await page.goto("/");
  await page.getByRole("button",{name:"Open saved dashboard",exact:true}).click();
  await page.getByRole("dialog",{name:"Saved dashboards"}).getByRole("button",{name:title,exact:false}).click();
  const tile = page.getByRole("group",{name:"Revenue across observed months",exact:true});
  const assertBroken = async (root: typeof tile) => {
    if(kind === "areaStacked") {
      await expect(root.locator(".chart-err")).toContainText("A stacked area needs every component in each period");
      return;
    }
    const paths = root.locator('g[aria-label="line"] path');
    await expect(paths.first()).toBeVisible();
    for(const path of await paths.all()) expect(((await path.getAttribute("d")) ?? "").match(/M/g)).toHaveLength(2);
  };
  await assertBroken(tile);
  await tile.getByRole("button",{name:"1 data check to review",exact:true}).click();
  const evidence = page.getByRole("dialog",{name:"Metric definition and scope"});
  await expect(evidence).toContainText("3 returned rows checked");
  await expect(evidence).toContainText("Gaps in the returned time series");
  const download = page.waitForEvent("download");
  await evidence.getByRole("button",{name:"Download raw CSV",exact:true}).click();
  const csvPath = info.outputPath("actual-query.csv");
  await (await download).saveAs(csvPath);
  const csv = await readFile(csvPath,"utf8");
  expect(csv.trim().split(/\r?\n/)).toHaveLength(4);
  expect(csv).not.toContain("2026-02-01");
  for(const row of rows) expect(csv).toContain(String(row[0]));
  await evidence.getByRole("button",{name:"Close",exact:true}).click();
  await page.getByRole("button",{name:"Review and share",exact:true}).click();
  const review = page.getByRole("dialog",{name:"Review and share"});
  for(const mode of ["Dashboard","Story","Infographic"]){
    await review.getByRole("button",{name:mode,exact:true}).click();
    await assertBroken(review);
  }
  await review.getByRole("button",{name:"Expand presentation",exact:true}).click();
  if(example === "line") {
    const image = page.waitForEvent("download");
    await review.getByRole("button",{name:"Export infographic as PNG",exact:true}).click();
    await (await image).saveAs(info.outputPath("missing-month-infographic.png"));
  }
  await review.locator(".report-item").first().screenshot({path:info.outputPath(`${example}-missing-month.png`)});
});
