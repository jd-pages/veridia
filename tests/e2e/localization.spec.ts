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

test("正式版任务和设置页面不显示测试链接或内部配置", async ({ page }) => {
  const loginResponse = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(loginResponse.ok()).toBeTruthy();
  const currentUser = (await (
    await page.request.get("/api/auth/me")
  ).json()).data as { accountId: string };

  await page.goto("/tasks");
  await expect(
    page.getByPlaceholder("每行粘贴一个小红书笔记链接"),
  ).toBeVisible();
  await expect(page.getByText("默认填充", { exact: true })).toHaveCount(0);
  await expect(
    page.getByPlaceholder("每行粘贴一个小红书笔记链接"),
  ).toHaveValue("");

  await page.goto("/settings");
  await expect(page.getByText("账号标识", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(currentUser.accountId, { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByText(`••••${currentUser.accountId.slice(-6)}`, { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText("DEFAULT_MIN_IMAGES")).toHaveCount(0);
  await expect(page.getByText("SETUP_COMPLETED")).toHaveCount(0);
  await expect(page.getByText(/GitHub规则仓库/u)).toHaveCount(0);
});
