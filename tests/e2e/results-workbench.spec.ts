import { expect, test, type Page } from "@playwright/test";
import ExcelJS from "exceljs";

async function login(page: Page) {
  const response = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  if (!response.ok()) {
    throw new Error(
      `E2E 管理员登录失败 (${response.status()}): ${await response.text()}`,
    );
  }
}

test("审核结果决策工作台整合列、筛选、批量操作和详情抽屉", async ({
  page,
  context,
}) => {
  await login(page);
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/results");
  await expect(page).toHaveTitle("VERIDIA");
  await expect(page.getByText("日期范围", { exact: true })).toBeVisible();
  await expect(page.getByLabel("开始日期")).toHaveValue(
    /^\d{4}-\d{2}-01$/u,
  );
  await expect(page.getByLabel("结束日期")).toHaveValue(
    /^\d{4}-\d{2}-\d{2}$/u,
  );
  const dateDivider = page.getByLabel("日期范围分隔符");
  await expect(dateDivider).toHaveValue("至");
  const dividerBox = await dateDivider.boundingBox();
  expect(dividerBox).toBeTruthy();
  expect(dividerBox!.width).toBeGreaterThan(dividerBox!.height);
  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
    { width: 1093, height: 614 },
    { width: 1536, height: 864 },
  ]) {
    await page.setViewportSize(viewport);
    const startBox = await page.getByLabel("开始日期").boundingBox();
    const separatorBox = await dateDivider.boundingBox();
    const endBox = await page.getByLabel("结束日期").boundingBox();
    expect(startBox).toBeTruthy();
    expect(separatorBox).toBeTruthy();
    expect(endBox).toBeTruthy();
    expect(startBox!.width).toBeGreaterThan(80);
    expect(endBox!.width).toBeGreaterThan(80);
    expect(
      await page.getByLabel("开始日期").evaluate(
        (input) => input.scrollWidth <= input.clientWidth,
      ),
    ).toBe(true);
    expect(
      await page.getByLabel("结束日期").evaluate(
        (input) => input.scrollWidth <= input.clientWidth,
      ),
    ).toBe(true);
    expect(startBox!.x + startBox!.width).toBeLessThanOrEqual(separatorBox!.x);
    expect(separatorBox!.x + separatorBox!.width).toBeLessThanOrEqual(endBox!.x);
  }
  await page.setViewportSize({ width: 1366, height: 768 });

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

test("审核详情展示自动取证候选证据", async ({ page }) => {
  await login(page);
  const listResponse = await page.request.get("/api/results?page=1&pageSize=100");
  expect(listResponse.ok()).toBeTruthy();
  const listPayload = (await listResponse.json()) as {
    data: {
      items: Array<{
        id: string;
        note: { platformNoteId: string | null };
      }>;
    };
  };
  const evidenceFixture = listPayload.data.items.find((item) =>
    item.note.platformNoteId?.startsWith("isolated-fixture-"),
  );
  expect(evidenceFixture).toBeTruthy();

  await page.goto(`/results/${evidenceFixture!.id}`);
  await expect(page.getByText("自动取证证据", { exact: true })).toBeVisible();
  await expect(page.getByText("最终 URL", { exact: true })).toBeVisible();
  await expect(page.getByText("页面 title", { exact: true })).toBeVisible();
  await expect(page.getByText("正文候选", { exact: true })).toBeVisible();
  await expect(page.getByText("话题候选", { exact: true })).toBeVisible();
  await expect(page.getByText("图片候选", { exact: true })).toBeVisible();
  await expect(page.getByText("NOTE_DETAIL", { exact: true })).toBeVisible();
  await expect(page.getByText(/dom-visible-text/u)).toBeVisible();
  await expect(page.getByText(/dom-topic-link/u).first()).toBeVisible();
  await expect(page.getByText(/carousel-img/u).first()).toBeVisible();
});

test("ADMIN 可确认单条删除和批量删除审核结果", async ({ page }) => {
  await login(page);
  await page.goto("/results");
  await expect(page.locator(".ant-table-row").first()).toBeVisible();

  const initialList = (await (
    await page.request.get("/api/results?page=1&pageSize=100")
  ).json()) as {
    data: { total: number; items: Array<{ id: string }> };
  };
  const firstResultId = initialList.data.items[0].id;
  const detailResponse = await page.request.get(`/api/results/${firstResultId}`);
  expect(detailResponse.ok()).toBeTruthy();
  const detail = (await detailResponse.json()) as {
    data: {
      task: {
        id: string;
        productStage: string | null;
        product: { id: string };
        campaign: { id: string };
      };
    };
  };
  const rulesBefore = (await (
    await page.request.get(
      `/api/rules?campaignId=${detail.data.task.campaign.id}`,
    )
  ).json()) as { data: Array<{ id: string }> };

  const deleteRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      request.method() === "DELETE" &&
      url.pathname === `/api/results/${firstResultId}`
    ) {
      deleteRequests.push(request.url());
    }
  });

  await page.getByLabel("更多操作").first().click();
  await page.getByText("删除该结果", { exact: true }).click();
  let dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("确认删除该审核结果？", { exact: true }).last(),
  ).toBeVisible();
  await expect(
    dialog.getByText(
      "删除后，该审核结果及其关联审核明细将无法恢复，但不会删除原审核任务、导入记录、产品、活动或规则。",
      { exact: true },
    ),
  ).toBeVisible();
  await dialog.getByRole("button", { name: /取\s*消/u }).click();
  await expect(dialog).toBeHidden();
  expect(deleteRequests).toHaveLength(0);

  await page.getByLabel("更多操作").first().click();
  await page.getByText("删除该结果", { exact: true }).click();
  dialog = page.getByRole("dialog");
  const singleDeleteResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      new URL(response.url()).pathname === `/api/results/${firstResultId}`,
  );
  await dialog.getByRole("button", { name: /确认删除/u }).click();
  const singleDeletePayload = (await (await singleDeleteResponse).json()) as {
    data: { deletedCount: number; deletedIds: string[] };
  };
  expect(singleDeletePayload.data).toEqual({
    deletedCount: 1,
    deletedIds: [firstResultId],
  });
  await expect(
    page.getByText("已成功删除 1 条审核结果", { exact: true }),
  ).toBeVisible();
  await expect.poll(() => deleteRequests.length).toBe(1);

  const deletedDetail = await page.request.get(`/api/results/${firstResultId}`);
  expect(deletedDetail.status()).toBe(404);
  const tasks = (await (await page.request.get("/api/tasks")).json()) as {
    data: Array<{ id: string }>;
  };
  const products = (await (await page.request.get("/api/products")).json()) as {
    data: Array<{ id: string }>;
  };
  const campaigns = (await (
    await page.request.get("/api/campaigns")
  ).json()) as { data: Array<{ id: string }> };
  expect(tasks.data.some(({ id }) => id === detail.data.task.id)).toBeTruthy();
  expect(
    products.data.some(({ id }) => id === detail.data.task.product.id),
  ).toBeTruthy();
  expect(
    campaigns.data.some(({ id }) => id === detail.data.task.campaign.id),
  ).toBeTruthy();
  const rulesAfter = (await (
    await page.request.get(
      `/api/rules?campaignId=${detail.data.task.campaign.id}`,
    )
  ).json()) as { data: Array<{ id: string }> };
  expect(rulesAfter.data.map(({ id }) => id)).toEqual(
    rulesBefore.data.map(({ id }) => id),
  );

  const rows = page.locator(".ant-table-row");
  await expect(rows.nth(1)).toBeVisible();
  await rows.nth(0).getByRole("checkbox").check({ force: true });
  await rows.nth(1).getByRole("checkbox").check({ force: true });
  const batchDeleteButton = page.getByRole("button", {
    name: "批量删除（2）",
  });
  await expect(batchDeleteButton).toBeEnabled();

  const batchRequests: string[] = [];
  let batchDeletedIds: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/results/batch-delete"
    ) {
      batchRequests.push(request.url());
      batchDeletedIds = (request.postDataJSON() as { ids: string[] }).ids;
    }
  });
  await batchDeleteButton.click();
  dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("确认批量删除？", { exact: true }).last(),
  ).toBeVisible();
  await expect(
    dialog.getByText(
      "即将删除已选择的 2 条审核结果及其关联审核明细，删除后无法恢复。",
      { exact: true },
    ),
  ).toBeVisible();
  const batchDeleteResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/results/batch-delete",
  );
  await dialog.getByRole("button", { name: /确认删除/u }).click();
  const batchDeletePayload = (await (await batchDeleteResponse).json()) as {
    data: { deletedCount: number; deletedIds: string[] };
  };
  expect(batchDeletePayload.data.deletedCount).toBe(2);
  expect([...batchDeletePayload.data.deletedIds].sort()).toEqual(
    [...batchDeletedIds].sort(),
  );
  await expect(
    page.getByText("已成功删除 2 条审核结果", { exact: true }),
  ).toBeVisible();
  await expect.poll(() => batchRequests.length).toBe(1);
  await expect(page.getByText(/已选择\s*0\s*条/u)).toBeVisible();

  const finalList = (await (
    await page.request.get("/api/results?page=1&pageSize=100")
  ).json()) as {
    data: { total: number; items: Array<{ id: string }> };
  };
  const finalIds = finalList.data.items.map(({ id }) => id);
  expect(finalIds).not.toContain(firstResultId);
  for (const deletedId of batchDeletedIds) {
    expect(finalIds).not.toContain(deletedId);
  }
  await expect(
    page.getByText(`当前筛选共 ${finalList.data.total} 条`, { exact: true }),
  ).toBeVisible();
});
