import { expect, test } from "@playwright/test";

test("landing page explains the problem and links to the console", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Money that never mixes");
  await expect(page.getByText("Adding up the balances gives the wrong answer.")).toBeVisible();
  await page.getByRole("link", { name: "Run the live demo" }).click();
  await expect(page).toHaveURL(/\/console$/);
});

test("operator runs payroll for three employers and approves two decisions", async ({ page }) => {
  await page.goto("/console");
  const start = page.getByTestId("start-run");
  await expect(start).toBeEnabled({ timeout: 20_000 });
  await start.click();

  await expect(page.getByTestId("decision")).toContainText("Denied by policy", { timeout: 30_000 });
  await page.getByTestId("approve-beneficiary_change").click({ timeout: 30_000 });
  await page.getByTestId("approve-bridge_advance").click({ timeout: 30_000 });

  const proofs = page.getByTestId("proofs");
  await expect(proofs).toBeVisible({ timeout: 60_000 });
  await expect(proofs.getByText("✓ PASS")).toHaveCount(5);
  for (const key of ["A", "B", "C"]) await expect(page.getByTestId(`lane-${key}`)).toContainText("Complete");
});
