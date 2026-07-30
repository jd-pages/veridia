import { expect, test } from "@playwright/test";

test("审核任务页面业务状态与来源统一显示中文", async ({ page }) => {
  const loginResponse = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(loginResponse.ok()).toBeTruthy();

  await page.goto("/tasks");
  await expect(page.getByText("小红书专用浏览器", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("任务配置", { exact: true })).toBeVisible();
  await expect(page.getByText("默认模式", { exact: true })).toBeVisible();

  const bodyText = await page.locator("main").innerText();
  for (const untranslated of [
    "EXECUTION LOG",
    "RECENT ACTIVITY",
    "TASK CONFIGURATION",
    "DEFAULT MODE",
    "CONTROL FLOW",
    "SECURE BROWSER SESSION",
    "NO ISSUE",
    "CONTENT OK",
    "RULE MATCH",
    "FINAL ·",
    "RECORDS",
  ]) {
    expect(bodyText).not.toContain(untranslated);
  }

  await expect(
    page.getByRole("heading", { name: "创建审核任务", exact: true }),
  ).toBeVisible();
});
