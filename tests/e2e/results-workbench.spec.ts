import { expect, test, type Page } from "@playwright/test";

async function login(page: Page) {
  const response = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(response.ok()).toBeTruthy();
}

test("审核结果决策工作台整合列、筛选、批量操作和详情抽屉", async ({
  page,
}) => {
  await login(page);
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/results");

  await expect(
    page.getByText("查看自动审核结论、异常原因及人工复核记录"),
  ).toBeVisible();
  for (const label of ["结果总数", "审核通过", "审核不通过", "待人工复核"]) {
    await expect(page.getByRole("button", { name: new RegExp(label) })).toBeVisible();
  }

  const headers = page.locator(".ant-table-thead th");
  await expect(headers).toContainText([
    "笔记对象",
    "归属信息",
    "内容状态",
    "话题审核",
    "图片",
    "审核结论",
    "操作",
  ]);
  for (const removedColumn of [
    "笔记ID",
    "产品名称",
    "活动名称",
    "页面状态",
    "文章状态",
    "标签内容",
    "缺失标签",
    "不通过原因",
  ]) {
    await expect(
      page.locator(".ant-table-thead").getByText(removedColumn, { exact: true }),
    ).toHaveCount(0);
  }

  await page.getByRole("button", { name: /高级筛选/ }).click();
  await expect(page.getByLabel("不通过原因")).toBeVisible();
  await expect(page.getByText("留存验证状态", { exact: true })).toBeVisible();

  const firstRowCheckbox = page
    .locator(".ant-table-row")
    .first()
    .getByRole("checkbox");
  await firstRowCheckbox.check({ force: true });
  await expect(page.getByText(/已选择\s*1\s*条/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "批量重新审核" }),
  ).toBeEnabled();

  await page
    .getByRole("button", { name: /查看详情/ })
    .first()
    .click();
  await expect(page.getByText("笔记基础信息", { exact: true })).toBeVisible();
  await expect(page.getByText("自动审核与人工复核", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/results$/u);
});
