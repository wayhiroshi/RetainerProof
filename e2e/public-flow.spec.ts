import { expect, test } from "@playwright/test";

test("landing page explains the product and reaches pricing", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("invisible maintenance");
  await expect(page.getByText("Works with any website")).toBeVisible();
  await page.getByRole("link", { name: "See founding pricing" }).click();
  await expect(page).toHaveURL(/\/pricing$/);
  await expect(page.getByRole("heading", { name: "Starter" })).toBeVisible();
});

test("sample report shows factual scheduled-check language", async ({ page }) => {
  await page.goto("/sample");
  await expect(page.getByRole("heading", { name: "North & Pine Studio" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "30 of 30 scheduled checks passed" })).toBeVisible();
  await expect(page.getByText("GOOGLE SEARCH VISIBILITY")).toBeVisible();
  await expect(page.getByRole("heading", { name: "website care studio" })).toBeVisible();
  await expect(page.getByText("Average position is calculated")).toBeVisible();
  await expect(page.getByText("100% uptime")).toHaveCount(0);
});

test("Japanese landing and sample report stay in Japanese", async ({ page }) => {
  await page.goto("/ja");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("見えない保守作業");
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await page.getByRole("link", { name: "サンプルを見る" }).click();
  await expect(page).toHaveURL(/\/ja\/sample$/);
  await expect(page.getByRole("heading", { name: "ノース＆パイン・スタジオ" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "30回中30回の定期確認に成功" })).toBeVisible();
  await expect(page.getByText("WEBサイト保守 / 月次レポート")).toBeVisible();
  await expect(page.getByText("GOOGLE検索での表示状況")).toBeVisible();
  await expect(page.getByText("リアルタイム、すべての利用者共通、または保証された順位ではありません")).toBeVisible();
  await expect(page.getByText("100% uptime")).toHaveCount(0);
});

test("magic link request completes without exposing a password field", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByLabel("Work email")).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await page.getByLabel("Work email").fill("founder@example.com");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
  await expect(page.getByText("15 minutes and works once")).toBeVisible();
});
