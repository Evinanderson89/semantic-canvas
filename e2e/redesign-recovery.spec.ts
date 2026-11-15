import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";

const tiles = [
  { id: "countries", title: "Country signups", metrics: ["new_signups"], dimensions: ["dim_users.country"], chart: "barH", layout: { x: 24, y: 24, w: 480, h: 320 } },
  { id: "trend", title: "Monthly new MRR", metrics: ["new_mrr"], dimensions: ["month:movement_date"], chart: "line", layout: { x: 24, y: 380, w: 540, h: 320 } },
];
async function open(page: Page, content: unknown[]) {
  const spec = { title: `Redesign recovery ${crypto.randomUUID()}`, tiles: content };
  const saved = await page.request.post("/api/dashboards", { data: { id: crypto.randomUUID(), spec, canvas: { ...DEFAULT_CANVAS, width: 1120, height: 900 }, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.goto("/"); await page.getByLabel("Acting as", { exact: true }).selectOption("admin");
  await page.getByRole("button", { name: "Open saved dashboard", exact: true }).click();
  await page.getByRole("dialog", { name: "Saved dashboards" }).getByRole("button", { name: new RegExp(spec.title) }).click();
  await page.getByRole("button", { name: "Improve with AI", exact: true }).click();
  return page.getByRole("dialog", { name: "Reimagine this dashboard" });
}
test.beforeEach(async ({ page }) => {
  await page.route("**/api/agent/status", route => route.fulfill({ json: { configured: true } }));
});

for (const scenario of ["existing", "changed-chart", "new-failure"] as const) test(`redesign handles ${scenario} without disguising unchecked charts`, async ({ page }) => {
  let generated = false;
  await page.route("**/api/query", route => route.request().postDataJSON().metrics.includes("new_signups") && (scenario !== "new-failure" || generated)
    ? route.fulfill({ status: 503, json: { error: "Synthetic source unavailable" } }) : route.continue());
  await page.route("**/api/agent/chat", route => {
    generated = true;
    return route.fulfill({ json: { proposal: {
      title: "Compare the evidence", reason: "Place the trend beside the country breakdown; preserve its scope.",
      actions: [
        { type: "place", id: "trend", layout: { x: 528, y: 24, w: 540, h: 320 } },
        ...(scenario === "changed-chart" ? [{ type: "chart", id: "countries", chart: "bar" }] : []),
      ],
    } } });
  });
  const dialog = await open(page, tiles);
  if (scenario === "new-failure") await expect(dialog.locator("figure")).toHaveCount(2);
  else await expect(dialog.locator(".ai-redesign-render")).toContainText("Synthetic source unavailable");
  await dialog.getByRole("button", { name: "Show me a better dashboard" }).click();
  const checks = dialog.locator(".redesign-checks");
  const apply = dialog.getByRole("button", { name: "Apply redesign", exact: true });
  await expect(checks).toContainText("Synthetic source unavailable");
  await expect(apply).toBeDisabled();
  if (scenario === "existing") {
    await expect(checks).toContainText("Existing chart issues remain");
    await expect(checks).toContainText("queries, chart types, formatting and sizes are unchanged");
    await checks.getByRole("checkbox", { name: "Apply with these existing chart issues" }).check();
    await expect(apply).toBeEnabled();
    await checks.getByRole("button", { name: "Retry chart checks" }).click();
    await expect(checks.getByRole("checkbox", { name: "Apply with these existing chart issues" })).not.toBeChecked();
    await expect(apply).toBeDisabled();
    await checks.getByRole("checkbox", { name: "Apply with these existing chart issues" }).check();
    await expect(apply).toBeEnabled();
    await dialog.screenshot({ path: "../../outputs/semantic-canvas-local/redesign-existing-issues.png" });
    await apply.click();
    await expect(dialog.locator("footer")).toContainText("Redesign applied");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.locator(".node").filter({ hasText: "Country signups" })).toContainText("Synthetic source unavailable");
    const changed = await page.locator(".node").filter({ hasText: "Monthly new MRR" }).getAttribute("style");
    expect(changed).toContain("left: 528px");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
    await expect(page.locator(".node").filter({ hasText: "Monthly new MRR" })).toHaveAttribute("style", /left: 24px/);
  } else {
    await expect(checks).toContainText("Preview needs attention");
    await expect(checks.getByRole("checkbox")).toHaveCount(0);
    await expect(apply).toBeDisabled();
  }
});

test("a text-only story layout can be reviewed and applied without nonexistent chart checks", async ({ page }) => {
  const text = { id: "note", kind: "text", text: "Questions for the revenue review", metrics: [], dimensions: [], layout: { x: 24, y: 24, w: 600, h: 160 } };
  await page.route("**/api/agent/chat", route => route.fulfill({ json: { proposal: {
    title: "Make room for the review", reason: "Move the reading guide below the title area.", actions: [{ type: "place", id: "note", layout: { x: 24, y: 120, w: 600, h: 160 } }],
  } } }));
  const dialog = await open(page, [text]);
  await dialog.getByRole("button", { name: "Show me a better dashboard" }).click();
  await expect(dialog.locator(".redesign-checks")).toContainText("This proposal contains no charts");
  await expect(dialog.locator(".redesign-checks")).not.toContainText("Queries and charts checked");
  await dialog.getByRole("button", { name: "Apply redesign", exact: true }).click();
  await expect(dialog.locator("footer")).toContainText("Redesign applied");
});
