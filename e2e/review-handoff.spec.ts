import { expect, test } from "@playwright/test";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";

for (const mode of ["Dashboard", "Story", "Infographic"]) test(`${mode} copies pending and failed chart evidence, then replaces it after recovery`, async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  let phase: "pending" | "error" | "ready" = "pending";
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/query", async route => {
    const metric = route.request().postDataJSON().metrics[0];
    if (metric === "churned_mrr") {
      if (phase === "pending") await held;
      if (phase === "error") {
        await route.fulfill({ status: 503, json: { error: "Renewal source unavailable" } });
        return;
      }
    }
    await route.fulfill({ json: { columns: ["movement_date_month", metric], rows: [["2026-01-01", 100], ["2026-02-01", 120]], ms: 1,
      window: { start: "2026-01-01", end: "2026-02-01" }, rlsApplied: ["sample-country-policy"] } });
  });
  const title = `Handoff checks ${crypto.randomUUID()}`;
  const filter = { id: "country", source: "dimension", field: "dim_users.country", mode: "discrete", values: ["US"] };
  const spec = { title, tiles: ["new_mrr", "churned_mrr"].map((metric, i) => ({
    id: metric, title: i ? "Lost revenue" : "New revenue", metrics: [metric], dimensions: ["month:movement_date"],
    chart: "line", where: [filter], layout: { x: 24 + i * 480, y: 24, w: 460, h: 360 },
  })) };
  const saved = await page.request.post("/api/dashboards", { data: { id: crypto.randomUUID(), revision: 0, spec, canvas: DEFAULT_CANVAS } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(title) }).click();
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review and share" });
  await review.getByRole("group", { name: "Presentation format" }).getByRole("button", { name: mode, exact: true }).click();
  const copy = async () => {
    await review.getByRole("button", { name: "Copy review context", exact: true }).click();
    return page.evaluate(() => navigator.clipboard.readText());
  };
  const exportButton = review.getByRole("button", { name: `Export ${mode.toLowerCase()} as PNG` });
  await expect(review).toContainText("1 of 2 selected charts queried and rendered");
  await expect(exportButton).toBeDisabled();
  const pending = await copy();
  expect(pending).toContain("Check: checking");
  expect(pending).toContain("1 ready, 0 failed, 1 checking");
  expect(pending).toContain("Pending; this chart has not finished its query and rendering checks.");
  expect(pending).toContain("Reporting date: 2026-08-31 (fixed model clock)");
  expect(pending).toContain("not a warehouse freshness timestamp");
  // The diagnosis remains shareable, even with a broken source.
  phase = "error"; release();
  await expect(review.locator(".report-document .tile .err")).toContainText("Renewal source unavailable");
  await expect(exportButton).toBeDisabled();
  const failed = await copy();
  expect(failed).toContain("Check: error — Renewal source unavailable");
  expect(failed).toContain('"field":"dim_users.country"');
  expect(failed).toContain('"values":["US"]');
  expect(failed).toContain("Reporting: month:movement_date");
  expect(failed).toContain("1 ready, 1 failed, 0 checking");
  expect(failed).toContain("Returned bucket dates: 2026-01-01 to 2026-02-01");
  expect(failed).toContain("Access rules reported: sample-country-policy");
  const failedChart = failed.slice(failed.indexOf("Lost revenue\nMetrics:"));
  expect(failedChart).toContain("Data observations: Unavailable because this chart failed its query or rendering checks.");
  expect(failedChart).not.toContain("sample-country-policy");
  expect(failedChart).not.toContain("2026-02-01");
  phase = "ready";
  await review.getByRole("button", { name: "Back to dashboard", exact: true }).click();
  await page.getByRole("button", { name: "Review and share", exact: true }).click();
  await review.getByRole("group", { name: "Presentation format" }).getByRole("button", { name: mode, exact: true }).click();
  await expect(exportButton).toBeEnabled();
  const recovered = await copy();
  expect(recovered).toContain("2 ready, 0 failed, 0 checking");
  expect(recovered).not.toContain("Renewal source unavailable");
  expect(recovered).not.toContain("Check: error");
  expect(recovered.match(/Access rules reported: sample-country-policy/g)).toHaveLength(2);
  expect(recovered).toContain("do not certify source completeness or business conclusions");
});
