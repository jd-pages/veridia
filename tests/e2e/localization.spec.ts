import { expect, test } from "@playwright/test";

test("审核任务页面业务状态与来源统一显示中文", async ({ page }) => {
  const loginResponse = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(loginResponse.ok()).toBeTruthy();

  await page.goto("/tasks");
  await expect(page.getByText("审核执行记录", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("最近全部任务", { exact: true }).first()).toBeVisible();
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

  await expect(page.getByText("手动添加", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("已完成", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("无异常", { exact: true }).first()).toBeVisible();
  await expect(
    page.getByText(/审核通过|审核不通过|待人工复核|暂无结论/).first(),
  ).toBeVisible();

  const resultsResponse = await page.request.get("/api/results?pageSize=1");
  expect(resultsResponse.ok()).toBeTruthy();
  const latestResult = (await resultsResponse.json()).data.items[0] as {
    id: string;
  };
  await page.goto(`/results/${latestResult.id}`);
  await expect(page.getByRole("heading", { name: "审核详情" })).toBeVisible();
  const detailText = await page.locator("main").innerText();
  expect(detailText).not.toMatch(
    /\b(PASSED|FAILED|NEEDS_REVIEW|READ_FAILED|COMPLETED|PENDING|MANUAL|NORMAL|IMAGE_TEXT|SUCCESS)\b/u,
  );
});
