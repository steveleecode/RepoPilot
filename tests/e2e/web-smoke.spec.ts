import { expect, test } from "@playwright/test";

test("web shell loads honest planned states", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "RepoPilot" })).toBeVisible();
  await expect(page.getByText("analysis unavailable")).toBeVisible();
  await expect(page.getByText("No audits yet")).toBeVisible();
});
