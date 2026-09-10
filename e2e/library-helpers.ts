import { expect, type Page } from "@playwright/test";
export async function openStarter(page: Page, name: string) {
  const folder = name === "SaaS overview" ? "Company overview" : name === "MRR movements" ? "Revenue & retention" : name === "Dashboard cleanup demo" ? "Examples" : "Growth & customers";
  const expand = page.getByRole("button", { name: `Expand folder ${folder}`, exact: true });
  await expect(page.getByRole("button", { name: "CoreCanvas Library", exact: true })).toBeVisible();
  await expect(page.locator(".library-folder-open").filter({ hasText: folder })).toBeVisible();
  const item = page.getByRole("button", { name: `Starter: ${name}`, exact: true });
  if (!await item.isVisible()) await expand.click();
  await item.click();
  await expect(item).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".node").first()).toBeVisible();
}
