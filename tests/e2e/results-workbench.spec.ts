import { expect, test, type Page } from "@playwright/test";
import ExcelJS from "exceljs";

async function login(page: Page) {
  const response = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(response.ok()).toBeTruthy();
}

test("审核结果决策工作台整合列、筛选、批量操作和详情抽屉", async ({
  page,
  context,
}) => {
  await login(page);
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/results");
  await expect(page.getByText("日期范围", { exact: true })).toBeVisible();
  await expect(page.getByLabel("开始日期")).toHaveValue(
    /^\d{4}-\d{2}-01$/u,
  );
  await expect(page.getByLabel("结束日期")).toHaveValue(
    /^\d{4}-\d{2}-\d{2}$/u,
  );

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

  await page.getByRole("combobox", { name: "页面状态" }).click();
  await page.getByText("页面正常", { exact: true }).last().click();
  await page.getByRole("button", { name: "查询" }).click();

  const exportRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/results/export")) {
      exportRequests.push(request.url());
    }
  });
  const pagesBeforeExport = context.pages().length;
  const exportButton = page.getByRole("button", {
    name: /导出当前结果/u,
  });
  const downloadPromise = page.waitForEvent("download");
  await exportButton.evaluate((button) => {
    for (let index = 0; index < 5; index += 1) {
      (button as HTMLButtonElement).click();
    }
  });
  const download = await downloadPromise;
  await expect.poll(() => exportRequests.length).toBe(1);
  expect(context.pages()).toHaveLength(pagesBeforeExport);
  expect(download.suggestedFilename()).toMatch(
    /^VERIDIA审核结果_当前筛选_\d{4}-\d{2}-\d{2}\.xlsx$/u,
  );
  const exportedUrl = new URL(exportRequests[0]);
  expect(exportedUrl.searchParams.get("startDate")).toMatch(
    /^\d{4}-\d{2}-01$/u,
  );
  expect(exportedUrl.searchParams.get("endDate")).toMatch(
    /^\d{4}-\d{2}-\d{2}$/u,
  );
  expect(exportedUrl.searchParams.get("dateType")).toBe("AUDITED_AT");
  expect(exportedUrl.searchParams.get("pageStatus")).toBe("NORMAL");
  const filteredList = (await (
    await page.request.get(
      `/api/results?${exportedUrl.searchParams.toString()}&page=1&pageSize=1`,
    )
  ).json()).data as { total: number };
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile((await download.path())!);
  expect(workbook.worksheets[0].rowCount - 1).toBe(filteredList.total);
  const exportHeaders = workbook.worksheets[0]
    .getRow(1)
    .values as unknown[];
  for (const requiredHeader of [
    "笔记链接",
    "笔记ID",
    "产品",
    "活动",
    "产品阶段话题",
    "页面状态",
    "正文状态",
    "话题审核结果",
    "图片数量",
    "自动审核结果",
    "人工复核结果",
    "最终审核结论",
    "不通过原因",
    "人工复核备注",
    "审核时间",
  ]) {
    expect(exportHeaders).toContain(requiredHeader);
  }
  await expect(page.getByText(/导出成功，共 \d+ 条/u)).toBeVisible();

  await page.getByLabel("关键词搜索").fill(`无结果-${Date.now()}`);
  await page.getByRole("button", { name: "查询" }).click();
  await expect(page.getByText("当前筛选共 0 条", { exact: true })).toBeVisible();
  await exportButton.evaluate((button) =>
    (button as HTMLButtonElement).click(),
  );
  await expect(
    page.getByText("当前筛选无结果，未生成文件", { exact: true }),
  ).toBeVisible();
  expect(exportRequests).toHaveLength(1);
  await page.getByRole("button", { name: "重置" }).click();
  await expect(page.locator(".ant-table-row").first()).toBeVisible();

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
