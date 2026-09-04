import { expect, test, type Page } from "@playwright/test";

/**
 * The render smoke test.
 *
 * Every white-screen and blank-chart failure shipped here passed `tsc`, passed
 * `vite build`, and passed 47 unit tests -- because none of them threw. They
 * were layout and paint failures, which is also why jsdom is the wrong tool: it
 * has no layout engine, so clientWidth is always 0 and the exact conditions
 * that caused the bugs cannot occur.
 *
 * Each test below corresponds to a defect that actually reached the user.
 */

/** Fail the run on any console error, not just on assertions. */
function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

async function openDashboard(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Home" }).waitFor();
  await page.locator(".nav.cat").first().click();
  await page.locator(".tile").first().waitFor();
  // Charts draw asynchronously after their query resolves.
  await expect
    .poll(async () => page.locator(".tile figure").count(), { timeout: 20_000 })
    .toBeGreaterThan(0);
}

test("the app renders something", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
  await expect(page.getByText("Suggest a dashboard")).toBeVisible();
  expect(errors, "console errors on load").toEqual([]);
});

test("a dashboard renders tiles with real content", async ({ page }) => {
  const errors = watchConsole(page);
  await openDashboard(page);
  expect(await page.locator(".tile").count()).toBeGreaterThan(3);
  await expect(page.locator(".kpi-value").first()).not.toHaveText("—");
  expect(errors, "console errors on a dashboard").toEqual([]);
});

test("every chart actually draws — not just mounts", async ({ page }) => {
  // The blank-chart bug: the figure existed in the DOM with zero marks, because
  // the draw effect bailed on a 0x0 measurement and no resize ever retried.
  await openDashboard(page);
  const figures = page.locator(".tile figure");
  const n = await figures.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const marks = await figures.nth(i).locator("svg path, svg rect, svg circle").count();
    expect(marks, `chart ${i} rendered no marks`).toBeGreaterThan(0);
  }
});

test("no chart escapes its tile", async ({ page }) => {
  // The legend-spill bug: Plot stacks a legend above the svg, so a figure given
  // height H is taller than H and overflowed the tile.
  await openDashboard(page);
  const spills = await page.evaluate(() =>
    [...document.querySelectorAll(".tile")].map((tile) => {
      const body = tile.querySelector<HTMLElement>(".body");
      const fig = body?.firstElementChild?.firstElementChild as HTMLElement | null;
      if (!body || fig?.tagName !== "FIGURE") return null;
      return {
        title: tile.querySelector("h4")?.textContent?.slice(0, 30) ?? "",
        spillY: fig.offsetHeight - body.clientHeight,
        scrollsX: body.scrollWidth > body.clientWidth + 1,
        scrollsY: body.scrollHeight > body.clientHeight + 1,
      };
    }).filter(Boolean));
  expect(spills.length).toBeGreaterThan(0);
  for (const s of spills as any[]) {
    expect(s.spillY, `${s.title} overflows vertically`).toBeLessThanOrEqual(0);
    expect(s.scrollsX, `${s.title} scrolls horizontally`).toBe(false);
    expect(s.scrollsY, `${s.title} scrolls vertically`).toBe(false);
  }
});

test("collapsing the sidebar does not blank the page", async ({ page }) => {
  // display:none on a grid child shifted main into the 0px column.
  await openDashboard(page);
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(page.locator(".sidebar")).toBeHidden();
  await expect(page.locator(".tile").first()).toBeVisible();
  const w = await page.locator(".main").evaluate((el) => el.clientWidth);
  expect(w, "main collapsed to zero width").toBeGreaterThan(400);
  // And there must be a way back.
  await page.getByRole("button", { name: "Show sidebar" }).click();
  await expect(page.locator(".sidebar")).toBeVisible();
});

test("a new element lands where the user can see it", async ({ page }) => {
  // New tiles used to append below everything, landing off-screen on a full
  // canvas with no indication anything had happened.
  await openDashboard(page);
  const before = await page.locator(".tile").count();
  await page.getByRole("button", { name: /^Text$/ }).click();
  await page.getByText("Text note").click();
  await expect(page.locator(".tile")).toHaveCount(before + 1);
  const inView = await page.locator(".node.selected").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top < window.innerHeight && r.bottom > 0 && r.left < window.innerWidth;
  });
  expect(inView, "new element was placed outside the viewport").toBe(true);
});

test("locking hides edit chrome but keeps the data", async ({ page }) => {
  await openDashboard(page);
  await page.getByRole("button", { name: /Editing/ }).click();
  await expect(page.locator(".editbar select")).toHaveCount(0);
  await expect(page.locator(".tile").first()).toBeVisible();
  await expect(page.locator(".tile figure").first()).toBeVisible();
});
