import { expect, test } from "@playwright/test";

/**
 * Add a tile can start from a dimension: every table's columns are listed
 * before a metric is chosen, and a dimension picked first counts the
 * table's rows until a declared metric replaces it.
 */
test("a dimension picked first counts rows, and the tile draws", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Start from scratch/ }).click();
  await page.getByRole("button", { name: "Tile", exact: true }).click();
  const dialog = page.locator(".picker .sheet");
  await expect(dialog.getByText("Pick a metric, or a dimension to count rows by")).toBeVisible();
  await expect(dialog.locator(".dim-table", { hasText: "dim_users" })).toBeVisible();

  await dialog.locator(".dim-group", { hasText: "dim_users" }).getByRole("button", { name: /^country/ }).click();
  await expect(dialog.getByText(/Counting rows of dim_users/)).toBeVisible();
  await expect(dialog.getByTestId("row-count")).toHaveClass(/on/);
  // Metrics of other tables step back; dim_users' own stay available.
  await expect(dialog.getByRole("button", { name: /New signups/ })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: /^Events/ })).toBeDisabled();

  // A declared metric on the same table replaces the row count and keeps the breakdown.
  await dialog.getByRole("button", { name: /New signups/ }).click();
  await expect(dialog.getByTestId("row-count")).not.toHaveClass(/on/);
  await expect(dialog.getByRole("button", { name: /^country/ })).toHaveClass(/on/);
  // Unselecting it falls back to the row count rather than emptying the tile.
  await dialog.getByRole("button", { name: /New signups/ }).click();
  await expect(dialog.getByTestId("row-count")).toHaveClass(/on/);

  await dialog.getByRole("button", { name: /Choose visualization/ }).click();
  await expect(dialog.getByText("Row count of dim_users by country")).toBeVisible();
  await dialog.getByRole("button", { name: "Add tile" }).click();

  const tile = page.locator(".tile", { hasText: "Rows of dim_users" });
  await expect(tile).toBeVisible();
  await expect.poll(() => tile.locator("svg path, svg rect, svg circle").count(), { timeout: 20_000 }).toBeGreaterThan(0);
  await expect(tile.locator(".err")).toHaveCount(0);
});
