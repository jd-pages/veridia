import { expect, test, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { readFile } from "node:fs/promises";
import { createMockNote } from "../../lib/mock-data";
import { E2E_ORIGIN } from "./e2e-origin";

function worksheetHeaders(sheet: ExcelJS.Worksheet) {
  const headers: string[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell) => {
    headers.push(cell.text);
  });
  return headers;
}

async function waitForBatch(
  page: Page,
  batchId: string,
  terminalStatuses: string[],
) {
  return expect
    .poll(
      async () => {
        const response = await page.request.get("/api/automation/batches");
        const batches = (await response.json()).data as Array<{
          id: string;
          status: string;
          finishedAt: string | null;
          stats: Record<string, number>;
          tasks: Array<{
            status: string;
            finishedAt: string | null;
            attempts: number;
            failureCode: string | null;
            auditResults: Array<{ id: string }>;
          }>;
        }>;
        const batch = batches.find((item) => item.id === batchId);
        return batch && terminalStatuses.includes(batch.status) ? batch : null;
      },
      { timeout: 60_000 },
    )
    .not.toBeNull()
    .then(async () => {
      const response = await page.request.get("/api/automation/batches");
      const batches = (await response.json()).data;
      return batches.find((item: { id: string }) => item.id === batchId);
    });
}

test("本地账号登录、创建任务、审核、详情、Excel 与插件提交链路", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/login");
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill("Admin123!");
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole("heading", { name: "审核工作台" })).toBeVisible();

  const ruleStatusBefore = await page.request.get("/api/rule-sync/status");
  expect(ruleStatusBefore.ok()).toBeTruthy();
  const beforeRules = (await ruleStatusBefore.json()).data;
  expect(beforeRules.currentVersion).toBeTruthy();
  expect(beforeRules.counts.products).toBeGreaterThan(0);
  let appliedRuleSync = await page.request.post("/api/rule-sync/apply");
  for (let attempt = 1; attempt < 3 && !appliedRuleSync.ok(); attempt += 1) {
    appliedRuleSync = await page.request.post("/api/rule-sync/apply");
  }
  const ruleStatusAfter = await page.request.get("/api/rule-sync/status");
  const afterRules = (await ruleStatusAfter.json()).data;
  if (appliedRuleSync.ok()) {
    expect(afterRules.currentVersion).toBe(afterRules.latestVersion);
    expect(afterRules.currentVersion).toMatch(/^rules-\d{4}\.\d{2}\.\d{2}\.\d+$/u);
    expect(afterRules.source).toBe("GITHUB");
  } else {
    expect(afterRules.currentVersion).toBe(beforeRules.currentVersion);
    expect(afterRules.status).toBe("FAILED");
  }
  const builtinRules = JSON.parse(
    await readFile(
      new URL("../../rules/default-rules.json", import.meta.url),
      "utf8",
    ),
  ) as {
    products: Array<{ name: string }>;
    campaigns: Array<{ key: string; name: string; month: string }>;
    stageGroups: unknown[];
    topicRules: Array<{ campaignKey: string | null }>;
  };
  const danoneAugustCampaign = builtinRules.campaigns.find(
    (item) => item.key === "activity_danone_2026_08",
  );
  const danoneAugustRules = builtinRules.topicRules.filter(
    (item) => item.campaignKey === danoneAugustCampaign?.key,
  );
  expect(danoneAugustCampaign).toMatchObject({
    name: "爱他美2026年8月小红书种草审核",
    month: "2026-08",
  });
  expect(danoneAugustRules).toHaveLength(9);
  expect(afterRules.counts.products).toBeGreaterThanOrEqual(
    builtinRules.products.length,
  );
  expect(afterRules.counts.activities).toBeGreaterThanOrEqual(
    builtinRules.campaigns.length,
  );
  expect(afterRules.counts.stageGroups).toBeGreaterThanOrEqual(
    builtinRules.stageGroups.length,
  );
  expect(afterRules.counts.topicRules).toBeGreaterThanOrEqual(
    builtinRules.topicRules.length,
  );

  const productsResponse = await page.request.get("/api/products");
  expect(productsResponse.ok()).toBeTruthy();
  const products = (await productsResponse.json()).data as Array<{ id: string; code: string; name: string }>;
  expect(
    builtinRules.products.every((expected) =>
      products.some((actual) => actual.name === expected.name),
    ),
  ).toBe(true);
  const product =
    products.find((item) => item.name.includes("澳洲白金版")) ||
    products[0];
  expect(product).toBeTruthy();
  const campaignsResponse = await page.request.get(`/api/campaigns?productId=${product.id}`);
  const availableCampaigns = (await campaignsResponse.json()).data as Array<{
    id: string;
    name: string;
    month: string;
  }>;
  const campaign =
    availableCampaigns.find((item) => item.month === "2026-07") ||
    availableCampaigns[0];
  expect(campaign).toBeTruthy();
  const douyinCampaignsResponse = await page.request.get(
    `/api/campaigns?productId=${product.id}&contentChannel=DOUYIN`,
  );
  const douyinCampaigns = (await douyinCampaignsResponse.json()).data as Array<{
    id: string;
    name: string;
    month: string;
  }>;
  const douyinCampaign =
    douyinCampaigns.find((item) => item.month === campaign.month) ||
    douyinCampaigns[0];
  expect(douyinCampaign).toBeTruthy();

  const ruleTemplateWorkbook = new ExcelJS.Workbook();
  await ruleTemplateWorkbook.xlsx.load(
    (await readFile(
      "templates/活动规则标准导入模板.xlsx",
    )) as unknown as ExcelJS.Buffer,
  );
  ruleTemplateWorkbook.getWorksheet("话题规则")!.getCell("A3").value =
    " 澳　白 ";
  const ruleTemplateBuffer = Buffer.from(
    await ruleTemplateWorkbook.xlsx.writeBuffer(),
  );
  const rulePreviewResponse = await page.request.post("/api/rule-import", {
    multipart: {
      file: {
        name: "活动规则标准导入模板.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: ruleTemplateBuffer,
      },
      commit: "false",
      metadata: JSON.stringify({
        campaignName: "爱他美2026年7月小红书种草审核",
        month: "2026-07",
        startDate: "2026-07-01",
        endDate: "2026-07-31",
      }),
    },
  });
  expect(rulePreviewResponse.ok()).toBeTruthy();
  const rulePreview = (await rulePreviewResponse.json()).data as {
    campaign: {
      customerRegistrationNotes: string;
      minImageCount?: number;
      minBodyLength: number;
    };
    topicRules: Array<{ productName: string | null; topic: string }>;
  };
  expect(rulePreview.campaign.customerRegistrationNotes).toMatch(
    /图片.*不参与自动审核/u,
  );
  expect(rulePreview.campaign.minImageCount).toBe(2);
  expect(rulePreview.campaign.minBodyLength).toBe(30);
  expect(
    rulePreview.topicRules.find(
      (rule) => rule.topic === "#爱他美澳洲白金版",
    )?.productName,
  ).toBe("爱他美澳洲白金版");

  const suffix = Date.now();
  const taskUrl = `${E2E_ORIGIN}/mock/xhs?case=passed&e2e=${suffix}`;
  const createTaskResponse = await page.request.post("/api/tasks", {
    data: {
      urls: taskUrl,
      productId: product.id,
      campaignId: campaign.id,
      productStage: "IFFO_2",
      notes: "Playwright E2E",
      skipDuplicates: true,
    },
  });
  expect(createTaskResponse.ok()).toBeTruthy();
  const task = (await createTaskResponse.json()).data.created[0] as { id: string };
  expect(task.id).toBeTruthy();

  const auditResponse = await page.request.post(`/api/tasks/${task.id}/audit`, {
    data: { mockCase: "passed" },
  });
  const auditPayload = await auditResponse.json();
  expect(
    auditResponse.ok(),
    `审核接口失败 (${auditResponse.status()}): ${JSON.stringify(auditPayload)}`,
  ).toBeTruthy();
  const auditResult = auditPayload.data as {
    id: string;
    autoStatus: string;
    imageStatus: string;
    imageCount: number;
  };
  expect(["PASSED", "FAILED", "NEEDS_REVIEW"]).toContain(
    auditResult.autoStatus,
  );
  expect(auditResult.imageStatus).toBe("COMPLIANT");
  expect(auditResult.imageCount).toBeGreaterThanOrEqual(2);

  await page.goto(`/results/${auditResult.id}`);
  await expect(page.getByRole("heading", { name: "审核详情" })).toBeVisible();
  await expect(page.getByText(product.name, { exact: true }).first()).toBeVisible();

  const exportResponse = await page.request.get(
    `/api/results/export?ids=${auditResult.id}`,
  );
  expect(exportResponse.ok()).toBeTruthy();
  expect(exportResponse.headers()["content-type"]).toContain(
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  expect(exportResponse.headers()["content-disposition"]).toMatch(
    /VERIDIA%E5%AE%A1%E6%A0%B8%E7%BB%93%E6%9E%9C_%E6%89%80%E9%80%89%E7%BB%93%E6%9E%9C_\d{8}_\d{6}\.xlsx/u,
  );
  const exportWorkbook = new ExcelJS.Workbook();
  await exportWorkbook.xlsx.load(
    (await exportResponse.body()) as unknown as ExcelJS.Buffer,
  );
  const exportHeaders = worksheetHeaders(exportWorkbook.worksheets[0]);
  expect(exportHeaders).toEqual([
    "平台",
    "店铺名称",
    "客户名",
    "产品系列",
    "阶段",
    "段位",
    "订单编号",
    "内容渠道",
    "链接",
    "发布时间",
    "活动名称",
    "自审",
  ]);
  const exportSheet = exportWorkbook.worksheets[0];
  expect(exportSheet.rowCount - 1).toBe(
    Number(exportResponse.headers()["x-veridia-export-count"]),
  );
  expect(exportSheet.rowCount).toBeGreaterThan(1);
  const selfReviewColumn = exportHeaders.indexOf("自审") + 1;
  const exportedSelfReview = exportSheet
    .getRow(2)
    .getCell(selfReviewColumn).text;
  expect([
    "Y",
    "N-帖子无法查看",
    "N-内容渠道不支持",
    "N-缺少话题",
    "N-字数不够",
    "N-图片不足",
    "N-阶段不符",
    "N-其他不合规",
    "",
  ]).toContain(exportedSelfReview.split("；")[0]);

  const emptyExportResponse = await page.request.get(
    `/api/results/export?keyword=no-export-${suffix}`,
  );
  expect(emptyExportResponse.status()).toBe(404);
  expect(await emptyExportResponse.json()).toMatchObject({
    success: false,
    error: "当前筛选无结果，未生成文件",
    errorDetail: {
      code: "NO_EXPORT_RESULTS",
      message: "当前筛选无结果，未生成文件",
    },
  });

  const csvExportResponse = await page.request.get(
    `/api/results/export?ids=${auditResult.id}&format=csv`,
  );
  expect(csvExportResponse.ok()).toBeTruthy();
  expect(csvExportResponse.headers()["content-type"]).toContain("text/csv");
  expect(csvExportResponse.headers()["content-disposition"]).toMatch(
    /VERIDIA%E5%AE%A1%E6%A0%B8%E7%BB%93%E6%9E%9C_%E6%89%80%E9%80%89%E7%BB%93%E6%9E%9C_\d{8}_\d{6}\.csv/u,
  );
  const csvExport = await csvExportResponse.body();
  expect(csvExport[0]).toBe(0xef);
  expect(csvExport[1]).toBe(0xbb);
  expect(csvExport[2]).toBe(0xbf);
  expect(csvExport.toString("utf8")).toContain("平台,店铺名称,客户名");
  expect(csvExport.toString("utf8")).toContain("自审");
  expect(csvExport.toString("utf8")).not.toContain("正文内容");

  const taskExportResponse = await page.request.get(
    "/api/tasks/export?format=xlsx",
  );
  expect(taskExportResponse.ok()).toBeTruthy();

  await page.goto("/tasks");
  await page.getByRole("tab", { name: "Excel 自动审核" }).click();
  const pageCountBeforeTemplateDownloads = page.context().pages().length;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const templateDownloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载导入模板" }).click();
    const templateMenuItem = page.getByRole("menuitem", {
      name: "下载达能客户 Excel 模板",
    });
    await expect(templateMenuItem).toBeVisible();
    await templateMenuItem.click({ force: true });
    const templateDownload = await templateDownloadPromise;
    expect(templateDownload.suggestedFilename()).toMatch(
      /^VERIDIA达能客户导入模板_.+_\d{4}-\d{2}-\d{2}\.xlsx$/u,
    );
  }
  expect(page.context().pages()).toHaveLength(pageCountBeforeTemplateDownloads);
  await expect(page).toHaveURL(/\/tasks(?:\?batchId=[^#]+)?$/u);

  const noteTemplateResponse = await page.request.get("/api/import/template");
  expect(noteTemplateResponse.ok()).toBeTruthy();
  const noteTemplateWorkbook = new ExcelJS.Workbook();
  await noteTemplateWorkbook.xlsx.load(
    (await noteTemplateResponse.body()) as unknown as ExcelJS.Buffer,
  );
  const noteTemplateHeaders = worksheetHeaders(
    noteTemplateWorkbook.worksheets[0],
  );
  expect(noteTemplateHeaders).toEqual([
    "平台（必填）",
    "店铺名称（必填）",
    "客户名（必填）",
    "产品系列（必填）",
    "阶段（必填）",
    "段位（必填）",
    "订单编号（必填）",
    "内容渠道（必填）",
    "链接（必填）",
    "发布时间（必填）",
    "活动名称（必填）",
  ]);
  const downloadedTemplateSheet = noteTemplateWorkbook.worksheets[0];
  for (let index = 0; index < 9; index += 1) {
    downloadedTemplateSheet.getRow(index + 2).values = [
      "京东",
      "京东健康官方进口超市",
      "E2E 客户",
      product.name,
      "2段",
      "IFFO",
      `PREVIEW-${suffix}-${index}`,
      "小红书",
      `${E2E_ORIGIN}/mock/xhs?case=passed&preview-layout=${suffix}-${index}`,
      "2026-08-03 12:00:00",
      campaign.name,
    ];
  }
  await page.locator('input[type="file"]').setInputFiles({
    name: "preview-layout.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(await noteTemplateWorkbook.xlsx.writeBuffer()),
  });
  await page.getByRole("button", { name: "开始预检查" }).click();
  await expect(page.getByText("可导入 9 条，异常 0 条")).toBeVisible();
  await expect(page.getByText("预检查通过，无异常记录")).toBeVisible();
  await page.getByRole("button", { name: "查看全部记录" }).click();
  const previewTableContent = page.locator(".ant-table-content").last();
  await previewTableContent.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  const previewResultHeader = page.getByRole("columnheader", {
    name: "预检结果",
  });
  await expect(previewResultHeader).toBeVisible();
  const [tableBox, resultBox] = await Promise.all([
    previewTableContent.boundingBox(),
    previewResultHeader.boundingBox(),
  ]);
  expect(tableBox).not.toBeNull();
  expect(resultBox).not.toBeNull();
  expect(resultBox!.x).toBeGreaterThanOrEqual(tableBox!.x - 1);
  expect(resultBox!.x + resultBox!.width).toBeLessThanOrEqual(
    tableBox!.x + tableBox!.width + 1,
  );
  await expect(page.getByRole("cell", { name: "10", exact: true })).toBeVisible();
  await expect(page.locator(".ant-pagination-item-2").last()).toHaveCount(0);
  await expect(previewResultHeader).toBeVisible();

  downloadedTemplateSheet.getRow(6).getCell(11).value = "";
  await page.locator('input[type="file"]').setInputFiles({
    name: "preview-errors.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(await noteTemplateWorkbook.xlsx.writeBuffer()),
  });
  await page.getByRole("button", { name: "开始预检查" }).click();
  await expect(page.getByText("可导入 8 条，异常 1 条")).toBeVisible();
  await expect(page.getByText("当前仅显示异常记录，共 1 条。")).toBeVisible();
  const errorPreviewTable = page.locator(".ant-table").last();
  await expect(errorPreviewTable.locator('tbody tr[data-row-key]')).toHaveCount(1);
  await expect(errorPreviewTable).toContainText("活动名称不能为空");
  await page.getByRole("button", { name: "查看全部记录" }).click();
  await expect(errorPreviewTable.locator('tbody tr[data-row-key]')).toHaveCount(9);

  downloadedTemplateSheet.spliceRows(2, 9);
  downloadedTemplateSheet.getRow(2).values = [
    "京东",
    "京东健康官方进口超市",
    "E2E 客户",
    product.name,
    "2段",
    "IFFO",
    `MINIMAL-${suffix}`,
    "小红书",
    `${E2E_ORIGIN}/mock/xhs?case=passed&minimal-template=${suffix}`,
    "2026-08-03 12:00:00",
    campaign.name,
  ];
  const minimalTemplateImport = await page.request.post("/api/import/notes", {
    multipart: {
      file: {
        name: "minimal-template.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: Buffer.from(await noteTemplateWorkbook.xlsx.writeBuffer()),
      },
      commit: "true",
      skipDuplicates: "true",
    },
  });
  expect(minimalTemplateImport.ok()).toBeTruthy();
  const minimalTemplatePayload = (await minimalTemplateImport.json()).data as {
    imported: number;
    batchId: string;
  };
  expect(minimalTemplatePayload.imported).toBe(1);
  const minimalTemplateBatch = await waitForBatch(
    page,
    minimalTemplatePayload.batchId,
    ["COMPLETED"],
  );
  expect(minimalTemplateBatch.stats.succeeded).toBe(1);
  const minimalTemplateTask = (
    (await (await page.request.get("/api/tasks")).json()).data as Array<{
      url: string;
      notes: string | null;
    }>
  ).find((task) => task.url.includes(`minimal-template=${suffix}`));
  expect(minimalTemplateTask).toBeTruthy();
  expect(minimalTemplateTask?.notes).toContain(`订单编号：MINIMAL-${suffix}`);
  expect(minimalTemplateTask?.notes).toContain(`导入活动名称：${campaign.name}`);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("导入");
  sheet.addRow([
    "笔记链接",
    "产品编码",
    "产品名称",
    "活动名称",
    "活动月份",
    "产品阶段话题",
    "内容渠道",
    "店铺名称",
    "成交平台",
    "备注",
  ]);
  sheet.addRow([
    `标题 + ${E2E_ORIGIN}/mock/xhs?case=no-images&e2e-import=${suffix} + 说明文字`,
    product.code,
    product.name,
    campaign.name,
    campaign.month,
    "IFFO",
    "小红书",
    "京东健康官方进口超市",
    "京东",
    "E2E Excel 无图片但继续审核",
  ]);
  const hyperlinkImportRow = sheet.addRow([
    "点击打开小红书笔记",
    product.code,
    product.name,
    campaign.name,
    campaign.month,
    "IFFO",
    "小红书",
    "京东健康官方进口超市",
    "京东",
    "E2E Excel 单条失败",
  ]);
  hyperlinkImportRow.getCell(1).value = {
    text: "点击打开小红书笔记",
    hyperlink: `${E2E_ORIGIN}/mock/xhs?case=read-failed&e2e-import=${suffix}-failure`,
  };
  sheet.addRow([
    `${E2E_ORIGIN}/mock/xhs?case=passed&e2e-import=${suffix}-after-failure`,
    product.code,
    product.name,
    campaign.name,
    campaign.month,
    "IFFO",
    "",
    "京东健康官方进口超市",
    "京东",
    "E2E Excel 后续成功",
  ]);
  sheet.addRow([
    `${E2E_ORIGIN}/mock/douyin?case=video&e2e-import=${suffix}-douyin`,
    product.code,
    product.name,
    douyinCampaign.name,
    douyinCampaign.month,
    "IFFO",
    "抖音",
    "京东健康官方进口超市",
    "京东",
    "E2E 不支持平台不影响其他行",
  ]);
  const excel = Buffer.from(await workbook.xlsx.writeBuffer());
  const importBatchIdsBeforePreview = (
    (await (
      await page.request.get("/api/results/import-batches")
    ).json()).data as Array<{ id: string }>
  ).map((item) => item.id);
  const importResponse = await page.request.post("/api/import/notes", {
    multipart: {
      file: {
        name: "e2e-import.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: excel,
      },
      commit: "false",
      skipDuplicates: "true",
    },
  });
  expect(importResponse.ok()).toBeTruthy();
  const importPreview = (await importResponse.json()).data as {
    validCount: number;
    invalidCount: number;
    unknownHeaders: string[];
    rows: Array<{
      originalLinkContent: string;
      url: string;
      recognitionStatus: string;
      failureReason: string;
      errors: string[];
    }>;
  };
  expect(importPreview.validCount).toBe(4);
  expect(importPreview.invalidCount).toBe(0);
  expect(importPreview.unknownHeaders).toEqual(
    expect.arrayContaining(["产品编码", "活动月份", "备注"]),
  );
  expect(importPreview.unknownHeaders).not.toContain("内容渠道");
  expect(importPreview.rows[0].url).toContain("case=no-images");
  expect(importPreview.rows[0].originalLinkContent).toContain("标题 +");
  expect(importPreview.rows[1]).toMatchObject({
    originalLinkContent: "点击打开小红书笔记",
    recognitionStatus: "RECOGNIZED",
  });
  expect(importPreview.rows[1].url).toContain("case=read-failed");
  expect(importPreview.rows[2]).toMatchObject({
    recognitionStatus: "RECOGNIZED",
    errors: [],
  });
  expect(importPreview.rows[3]).toMatchObject({
    recognitionStatus: "RECOGNIZED",
    errors: [],
  });
  expect(importPreview).toMatchObject({
    plannedBatchCount: 2,
    channelDistribution: { XIAOHONGSHU: 3, DOUYIN: 1 },
  });
  const importBatchIdsAfterPreview = (
    (await (
      await page.request.get("/api/results/import-batches")
    ).json()).data as Array<{ id: string }>
  ).map((item) => item.id);
  expect(importBatchIdsAfterPreview).toEqual(importBatchIdsBeforePreview);

  const douyinWorkbook = new ExcelJS.Workbook();
  const douyinSheet = douyinWorkbook.addWorksheet("导入");
  douyinSheet.addRow([
    "笔记链接",
    "产品编码",
    "产品名称",
    "活动名称",
    "活动月份",
    "产品阶段话题",
    "内容渠道",
    "店铺名称",
    "成交平台",
    "备注",
  ]);
  douyinSheet.addRow([
    "https://www.douyin.com/video/987654321",
    product.code,
    product.name,
    douyinCampaign.name,
    douyinCampaign.month,
    "IFFO",
    "DOUYIN",
    "京东健康官方进口超市",
    "京东",
    "E2E 抖音独立文件预检",
  ]);
  const douyinPreviewResponse = await page.request.post("/api/import/notes", {
    multipart: {
      file: {
        name: "e2e-douyin-import.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: Buffer.from(await douyinWorkbook.xlsx.writeBuffer()),
      },
      commit: "false",
      skipDuplicates: "true",
    },
  });
  expect(douyinPreviewResponse.ok()).toBeTruthy();
  const douyinPreview = (await douyinPreviewResponse.json()).data as {
    validCount: number;
    invalidCount: number;
    rows: Array<{ channel: string; recognitionStatus: string; errors: string[] }>;
  };
  expect(douyinPreview).toMatchObject({ validCount: 1, invalidCount: 0 });
  expect(douyinPreview.rows[0]).toMatchObject({
    channel: "DOUYIN",
    recognitionStatus: "RECOGNIZED",
    errors: [],
  });

  const committedImportResponse = await page.request.post("/api/import/notes", {
    multipart: {
      file: {
        name: "e2e-automatic-import.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: excel,
      },
      commit: "true",
      skipDuplicates: "true",
    },
  });
  expect(committedImportResponse.ok()).toBeTruthy();
  const committedImport = (await committedImportResponse.json()).data as {
    imported: number;
    batchId: string;
    batchIds: string[];
    auditBatchId: string;
    importRecordId: string;
    fileName: string;
    importedAt: string;
    importedCount: number;
  };
  expect(committedImport).toMatchObject({
    imported: 4,
    importedCount: 4,
    auditBatchId: committedImport.batchId,
    fileName: "e2e-automatic-import.xlsx",
  });
  expect(committedImport.batchIds).toHaveLength(2);
  expect(committedImport.importRecordId).toBeTruthy();
  expect(new Date(committedImport.importedAt).toString()).not.toBe("Invalid Date");
  const excelBatch = await waitForBatch(page, committedImport.batchId, [
    "COMPLETED_WITH_ERRORS",
  ]);
  expect(excelBatch.stats.succeeded).toBe(2);
  expect(excelBatch.stats.failed).toBe(1);
  expect(excelBatch.stats.progress).toBe(100);
  expect(excelBatch.importRecordId).toBe(committedImport.importRecordId);
  expect(
    excelBatch.tasks.every(
      (task: { importRecordId: string | null }) =>
        task.importRecordId === committedImport.importRecordId,
    ),
  ).toBe(true);
  const douyinExcelBatch = await waitForBatch(page, committedImport.batchIds[1], [
    "COMPLETED",
  ]);
  expect(douyinExcelBatch.channel).toBe("DOUYIN");
  // Douyin now executes the shared store-topic validator. This row contains no
  // accepted store topic, so it is a business failure rather than an adapter
  // gap that needs manual review.
  expect(douyinExcelBatch.stats.needsReview).toBe(0);
  expect(douyinExcelBatch.importRecordId).toBe(committedImport.importRecordId);

  const importOptionsResponse = await page.request.get(
    "/api/results/import-batches",
  );
  expect(importOptionsResponse.headers()["cache-control"]).toContain("no-store");
  const importOptions = (await importOptionsResponse.json()).data as Array<{
    id: string;
    fileName: string;
    resultCount: number;
    label: string;
  }>;
  expect(importOptions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: committedImport.importRecordId,
        fileName: "e2e-automatic-import.xlsx",
        resultCount: 4,
        label: expect.stringContaining("导入 4 条"),
      }),
    ]),
  );
  const importResultsResponse = await page.request.get(
    `/api/results?importRecordId=${encodeURIComponent(committedImport.importRecordId)}&page=1&pageSize=100`,
  );
  const importResults = (await importResultsResponse.json()).data as {
    total: number;
    items: Array<{
      storeTopicStatus: string;
      storeTopicFailureReason: string | null;
      task: { importRecordId: string; channel: string };
    }>;
  };
  expect(importResults.total).toBe(4);
  expect(
    importResults.items.every(
      (item) => item.task.importRecordId === committedImport.importRecordId,
    ),
  ).toBe(true);
  const douyinImportResult = importResults.items.find(
    (item) => item.task.channel === "DOUYIN",
  );
  expect(douyinImportResult).toMatchObject({
    storeTopicStatus: "NON_COMPLIANT",
  });
  expect(douyinImportResult?.storeTopicFailureReason).toContain(
    "可接受店铺话题",
  );

  await page.goto(
    `/results?importRecordId=${encodeURIComponent(committedImport.importRecordId)}`,
  );
  await expect(
    page
      .getByLabel("导入批次")
      .first()
      .locator(".ant-select-selection-item"),
  ).toContainText("e2e-automatic-import.xlsx");
  await expect(page.getByText("当前筛选共 4 条")).toBeVisible();

  const clearImportedBatchResponse = await page.request.post(
    `/api/automation/batches/${committedImport.batchId}/clear`,
  );
  expect(clearImportedBatchResponse.ok()).toBeTruthy();
  expect(
    (
      await page.request.post(
        `/api/automation/batches/${committedImport.batchIds[1]}/clear`,
      )
    ).ok(),
  ).toBeTruthy();
  const clearedBatchLookup = await page.request.get(
    `/api/automation/batches?batchId=${committedImport.batchId}&includeTasks=false`,
  );
  expect((await clearedBatchLookup.json()).data).toEqual([]);
  const retainedImportResults = await page.request.get(
    `/api/results?importRecordId=${encodeURIComponent(committedImport.importRecordId)}&page=1&pageSize=100`,
  );
  expect((await retainedImportResults.json()).data.total).toBe(4);
  const retainedImportOptions = (await (
    await page.request.get("/api/results/import-batches")
  ).json()).data as Array<{ id: string }>;
  expect(retainedImportOptions.map((item) => item.id)).toContain(
    committedImport.importRecordId,
  );
  const duplicateImportResponse = await page.request.post(
    "/api/import/notes",
    {
      multipart: {
        file: {
          name: "e2e-automatic-import.xlsx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          buffer: excel,
        },
        commit: "true",
        skipDuplicates: "true",
      },
    },
  );
  expect(duplicateImportResponse.ok()).toBeTruthy();
  const duplicateImport = (await duplicateImportResponse.json()).data as {
    imported: number;
    batchId: string | null;
    importRecordId: string;
  };
  expect(duplicateImport).toMatchObject({ imported: 0, batchId: null });
  expect(duplicateImport.importRecordId).not.toBe(
    committedImport.importRecordId,
  );
  const sameNameImports = (
    (await (await page.request.get("/api/imports")).json()).data as Array<{
      id: string;
      fileName: string;
    }>
  ).filter((item) => item.fileName === "e2e-automatic-import.xlsx");
  expect(sameNameImports.map((item) => item.id)).toEqual(
    expect.arrayContaining([
      committedImport.importRecordId,
      duplicateImport.importRecordId,
    ]),
  );

  const resultCoverageSuffix = `${suffix}-result-coverage`;
  const resultCoverageBatchResponse = await page.request.post(
    "/api/automation/batches",
    {
      data: {
        name: "E2E 失败结果完整落库",
        productId: product.id,
        campaignId: campaign.id,
        productStage: "IFFO",
        urls: [
          `${E2E_ORIGIN}/mock/xhs?case=aptamil-stage2-passed&result-coverage=${resultCoverageSuffix}-passed`,
          `${E2E_ORIGIN}/mock/xhs?case=read-failed&result-coverage=${resultCoverageSuffix}-failed-1`,
          `${E2E_ORIGIN}/mock/xhs?case=read-failed&result-coverage=${resultCoverageSuffix}-failed-2`,
        ],
      },
    },
  );
  expect(resultCoverageBatchResponse.ok()).toBeTruthy();
  const resultCoverageBatchId = (
    await resultCoverageBatchResponse.json()
  ).data.batchId as string;
  const resultCoverageBatch = await waitForBatch(
    page,
    resultCoverageBatchId,
    ["COMPLETED_WITH_ERRORS"],
  );
  expect(resultCoverageBatch.stats.succeeded).toBe(1);
  expect(resultCoverageBatch.stats.failed).toBe(2);
  expect(resultCoverageBatch.finishedAt).toBeTruthy();
  expect(
    resultCoverageBatch.tasks.every(
      (task: { finishedAt: string | null }) => Boolean(task.finishedAt),
    ),
  ).toBe(true);
  const resultCoverageQuery = new URLSearchParams({
    batchId: resultCoverageBatchId,
  });
  const resultCoverageResponse = await page.request.get(
    `/api/results?${resultCoverageQuery}`,
  );
  expect(resultCoverageResponse.ok()).toBeTruthy();
  const resultCoverage = (await resultCoverageResponse.json()).data as {
    total: number;
    items: Array<{
      id: string;
      autoStatus: string;
      auditedAt: string;
      pageStatus: string;
      bodyStatus: string;
      topicsCompliant: boolean;
      clickableCompliant: boolean;
      imageStatus: string;
      noteType: string;
      ruleVersion: number;
      publicStatus: string;
      retentionStatus: string;
      task: {
        status: string;
        failureCode: string | null;
        platform: string | null;
        product: { id: string };
        campaign: { id: string };
      };
    }>;
  };
  expect(resultCoverage.total).toBe(3);
  expect(
    resultCoverage.items.filter((item) => item.autoStatus === "PASSED"),
  ).toHaveLength(1);
  expect(
    resultCoverage.items.filter(
      (item) =>
        item.autoStatus === "NEEDS_REVIEW" &&
        item.task.status === "READ_FAILED",
    ),
  ).toHaveLength(2);
  expect(
    resultCoverage.items
      .filter((item) => item.task.status === "READ_FAILED")
      .every((item) => item.task.failureCode === "PAGE_READ_FAILED"),
  ).toBe(true);
  const failedEvidenceResult = resultCoverage.items.find(
    (item) => item.task.status === "READ_FAILED",
  );
  expect(failedEvidenceResult).toBeTruthy();
  const failedEvidenceResponse = await page.request.get(
    `/api/results/${failedEvidenceResult!.id}`,
  );
  expect(failedEvidenceResponse.ok()).toBeTruthy();
  const failedEvidenceDetail = (await failedEvidenceResponse.json()).data as {
    note: { extractions: Array<{ rawData: string }> };
  };
  expect(failedEvidenceDetail.note.extractions.length).toBeGreaterThan(0);
  const failedEvidence = JSON.parse(
    failedEvidenceDetail.note.extractions[0].rawData,
  ) as {
    finalUrl?: string;
    pageTitle?: string;
    noteIdCandidates?: unknown[];
    bodyCandidates?: unknown[];
    topicCandidates?: unknown[];
    imageCandidates?: unknown[];
  };
  expect(failedEvidence.finalUrl).toContain("/mock/xhs");
  expect(failedEvidence.pageTitle).toBeTruthy();
  expect(failedEvidence.noteIdCandidates).toBeInstanceOf(Array);
  expect(failedEvidence.bodyCandidates).toBeInstanceOf(Array);
  expect(failedEvidence.topicCandidates).toBeInstanceOf(Array);
  expect(failedEvidence.imageCandidates).toBeInstanceOf(Array);

  const unavailableSuffix = `${suffix}-page-unavailable`;
  const unavailableBatchResponse = await page.request.post(
    "/api/automation/batches",
    {
      data: {
        name: "E2E 错误页识别",
        productId: product.id,
        campaignId: campaign.id,
        productStage: "IFFO",
        urls: [
          `${E2E_ORIGIN}/mock/xhs?case=not-found&unavailable=${unavailableSuffix}`,
        ],
      },
    },
  );
  expect(unavailableBatchResponse.ok()).toBeTruthy();
  const unavailableBatchId = (
    await unavailableBatchResponse.json()
  ).data.batchId as string;
  await waitForBatch(page, unavailableBatchId, ["COMPLETED"]);
  const unavailableResultsResponse = await page.request.get(
    `/api/results?batchId=${unavailableBatchId}`,
  );
  expect(unavailableResultsResponse.ok()).toBeTruthy();
  const unavailableResult = (await unavailableResultsResponse.json()).data
    .items[0] as {
    id: string;
    autoStatus: string;
    pageStatus: string;
    bodyStatus: string;
    imageStatus: string;
    missingTopics: string;
    failureReasons: string;
    task: {
      url: string;
      finalUrl: string | null;
      failureCode: string;
      failureMessage: string;
    };
  };
  expect(unavailableResult.autoStatus).toBe("NOTE_NOT_FOUND");
  expect(unavailableResult.pageStatus).toBe("NOTE_NOT_FOUND");
  expect(unavailableResult.bodyStatus).toBe("UNKNOWN");
  expect(unavailableResult.imageStatus).toBe("NOT_REQUIRED");
  expect(JSON.parse(unavailableResult.missingTopics)).toEqual([]);
  expect(unavailableResult.task.failureCode).toBe("NOTE_NOT_FOUND");
  expect(unavailableResult.task.failureMessage).toContain(
    "你访问的页面不见了",
  );
  expect(JSON.parse(unavailableResult.failureReasons).join("；")).not.toMatch(
    /未识别到话题|缺少精确话题|有效正文字数不足|图片数量不足/u,
  );
  const unavailableDetailResponse = await page.request.get(
    `/api/results/${unavailableResult.id}`,
  );
  const unavailableDetail = (await unavailableDetailResponse.json()).data as {
    note: { extractions: Array<{ rawData: string }> };
  };
  const unavailableEvidence = JSON.parse(
    unavailableDetail.note.extractions[0].rawData,
  ) as {
    pageTitle?: string;
    visibleTextPreview?: string;
    unavailablePage?: { status?: string; matchedText?: string };
  };
  expect(unavailableEvidence.visibleTextPreview).toContain("页面不存在");
  expect(unavailableEvidence.unavailablePage).toMatchObject({
    status: "NOTE_NOT_FOUND",
    matchedText: "你访问的页面不见了",
  });

  await page.goto("/results");
  await page.getByLabel("关键词搜索").fill(unavailableSuffix);
  await page.getByRole("button", { name: "查询" }).click();
  const unavailableRow = page.locator(".ant-table-tbody .ant-table-row").first();
  await expect(unavailableRow).toBeVisible();
  const unavailableCells = unavailableRow.locator("td");
  await expect(unavailableCells.nth(4)).toHaveText("未审核");
  await expect(unavailableCells.nth(5)).toHaveText("未审核");
  await expect(unavailableCells.nth(6)).toContainText(
    "未审核",
  );
  await expect(unavailableCells.nth(7)).toContainText("笔记不存在");
  await expect(unavailableCells.nth(7)).toContainText(
    "小红书页面提示",
  );
  await expect(unavailableRow).not.toContainText(
    /ERROR_PAGE|APP_LAUNCH|页面失效|未提取到正文|暂无结论|未执行话题审核|未执行图片数量审核|处理失败|待人工复核|项异常|缺少精准话题|有效正文字符不足|图片数量不足/u,
  );

  await unavailableRow.getByRole("button", { name: /查看详情/u }).click();
  const unavailableDrawer = page.locator(".ant-drawer-content");
  await expect(unavailableDrawer).toBeVisible();
  await expect(
    unavailableDrawer.getByText("笔记不存在", { exact: true }).first(),
  ).toBeVisible();
  const unavailableDrawerTopic = unavailableDrawer
    .getByRole("heading", { name: "话题审核", exact: true })
    .locator("..");
  const unavailableDrawerImage = unavailableDrawer
    .getByRole("heading", { name: "图片审核" })
    .locator("..");
  await expect(unavailableDrawerTopic).toContainText("未审核");
  await expect(unavailableDrawerImage).toContainText("未审核");
  await expect(unavailableDrawer.getByText("页面审核", { exact: true })).toBeVisible();
  await expect(unavailableDrawer.getByText("正文审核", { exact: true })).toBeVisible();
  await expect(unavailableDrawer.getByText("无法确认", { exact: true })).toBeVisible();
  await expect(unavailableDrawer.getByRole("heading", { name: "失败原因" })).toHaveCount(1);
  await expect(
    unavailableDrawer.getByRole("link", {
      name: "打开原笔记",
      exact: true,
    }),
  ).toHaveAttribute("href", unavailableResult.task.url);
  await expect(
    unavailableDrawer.getByRole("link", { name: "打开最终链接", exact: true }),
  ).toHaveCount(0);
  await expect(unavailableDrawer.getByText(unavailableResult.task.url, { exact: true })).toHaveCount(0);
  await expect(unavailableDrawer).not.toContainText(
    /ERROR_PAGE|APP_LAUNCH|页面失效|未提取到正文|未识别到话题|图片数量不足|处理失败|待人工复核/u,
  );

  await unavailableDrawer
    .getByRole("button", { name: "打开完整详情" })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/results/${unavailableResult.id}$`, "u"),
  );
  await expect(
    page.getByRole("link", {
      name: "打开原笔记",
      exact: true,
    }),
  ).toHaveAttribute("href", unavailableResult.task.url);
  await expect(page.getByRole("link", { name: "打开最终链接", exact: true })).toHaveCount(0);
  await expect(page.getByText("笔记基础信息", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/笔记ID/u)).toHaveCount(0);
  await expect(page.getByText(unavailableResult.task.url, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "失败原因" })).toHaveCount(1);
  await expect(page.getByText("笔记不存在", { exact: true })).toHaveCount(2);
  await expect(
    page.getByText(/小红书页面提示/u),
  ).toBeVisible();

  const notFoundFilterResponse = await page.request.get(
    "/api/results?status=NOTE_NOT_FOUND",
  );
  expect(notFoundFilterResponse.ok()).toBeTruthy();
  expect((await notFoundFilterResponse.json()).data.items).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: unavailableResult.id })]),
  );

  const reAuditResponse = await page.request.post("/api/results/bulk", {
    data: { ids: [unavailableResult.id], action: "RE_AUDIT" },
  });
  expect(reAuditResponse.ok()).toBeTruthy();
  const reAuditBatchId = (await reAuditResponse.json()).data.batchId as string;
  await waitForBatch(page, reAuditBatchId, ["COMPLETED"]);
  const reAuditedResults = await page.request.get(
    `/api/results?keyword=${encodeURIComponent(unavailableSuffix)}`,
  );
  const reAuditedData = (await reAuditedResults.json()).data;
  expect(reAuditedData.total).toBe(1);
  expect(reAuditedData.items[0].id).toBe(unavailableResult.id);

  const auditedDate = new Date(resultCoverage.items[0].auditedAt);
  const auditDay = [
    auditedDate.getFullYear(),
    String(auditedDate.getMonth() + 1).padStart(2, "0"),
    String(auditedDate.getDate()).padStart(2, "0"),
  ].join("-");
  const dateRangeQuery = new URLSearchParams({
    batchId: resultCoverageBatchId,
    startDate: auditDay,
    endDate: auditDay,
    dateType: "AUDITED_AT",
  });
  const dateRangeResults = (
    await (
      await page.request.get(`/api/results?${dateRangeQuery}`)
    ).json()
  ).data;
  expect(dateRangeResults.total).toBe(3);

  const startOnlyResults = (
    await (
      await page.request.get(
        `/api/results?${new URLSearchParams({
          batchId: resultCoverageBatchId,
          startDate: auditDay,
        })}`,
      )
    ).json()
  ).data;
  expect(startOnlyResults.total).toBe(3);

  const endOnlyResults = (
    await (
      await page.request.get(
        `/api/results?${new URLSearchParams({
          batchId: resultCoverageBatchId,
          endDate: auditDay,
        })}`,
      )
    ).json()
  ).data;
  expect(endOnlyResults.total).toBe(3);

  const clearedDateResults = (
    await (
      await page.request.get(
        `/api/results?${new URLSearchParams({
          batchId: resultCoverageBatchId,
        })}`,
      )
    ).json()
  ).data;
  expect(clearedDateResults.total).toBe(3);

  const productAndPassedResults = (
    await (
      await page.request.get(
        `/api/results?${new URLSearchParams({
          batchId: resultCoverageBatchId,
          startDate: auditDay,
          endDate: auditDay,
          productId: product.id,
          status: "PASSED",
        })}`,
      )
    ).json()
  ).data;
  expect(productAndPassedResults.total).toBe(1);

  const processFailedQuery = new URLSearchParams({
    batchId: resultCoverageBatchId,
    status: "PROCESS_FAILED",
  });
  const processFailedResults = (
    await (
      await page.request.get(`/api/results?${processFailedQuery}`)
    ).json()
  ).data;
  expect(processFailedResults.total).toBe(2);

  const pendingReviewQuery = new URLSearchParams({
    batchId: resultCoverageBatchId,
    manualStatus: "PENDING",
  });
  const pendingReviewResults = (
    await (
      await page.request.get(`/api/results?${pendingReviewQuery}`)
    ).json()
  ).data;
  expect(pendingReviewResults.total).toBe(2);

  const failedSample = resultCoverage.items.find(
    (item) => item.task.status === "READ_FAILED",
  )!;
  const fullFilterExportQuery = new URLSearchParams({
    startDate: auditDay,
    endDate: auditDay,
    dateType: "AUDITED_AT",
    productId: failedSample.task.product.id,
    campaignId: failedSample.task.campaign.id,
    platform: failedSample.task.platform || "XIAOHONGSHU",
    status: "PROCESS_FAILED",
    manualStatus: "PENDING",
    pageStatus: failedSample.pageStatus,
    bodyStatus: failedSample.bodyStatus,
    topicsStatus: failedSample.topicsCompliant
      ? "COMPLIANT"
      : "NON_COMPLIANT",
    imageStatus: failedSample.imageStatus,
    noteType: failedSample.noteType,
    reason: "人工确认",
    publicStatus: failedSample.publicStatus,
    keyword: `result-coverage=${resultCoverageSuffix}`,
    format: "csv",
  });
  const failureExportResponse = await page.request.get(
    `/api/results/export?${fullFilterExportQuery}`,
  );
  expect(failureExportResponse.ok()).toBeTruthy();
  const failureExportCsv = await failureExportResponse.text();
  expect(failureExportCsv.replace(/^\uFEFF/u, "").split("\r\n")[0]).toBe(
    [
      "平台",
      "店铺名称",
      "客户名",
      "产品系列",
      "阶段",
      "订单编号",
      "内容渠道",
      "链接",
      "发帖时间",
      "活动名称",
      "自审",
    ].join(","),
  );
  expect(failureExportResponse.headers()["x-veridia-export-count"]).toBe("2");

  expect(failureExportCsv).not.toContain("正文内容");

  await page.goto(`/tasks?batchId=${resultCoverageBatchId}`);
  const failedResult = resultCoverage.items.find(
    (item) => item.task.status === "READ_FAILED",
  );
  expect(failedResult).toBeTruthy();
  await expect(
    page.locator(`a[href="/results/${failedResult!.id}"]`).first(),
  ).toBeVisible();
  const failedDetailResponse = await page.request.get(
    `/api/results/${failedResult!.id}`,
  );
  expect(failedDetailResponse.ok()).toBeTruthy();
  const failedDetail = (await failedDetailResponse.json()).data as {
    bodyStatus: string;
    autoStatus: string;
    ruleSnapshot: string;
  };
  const failedSnapshot = JSON.parse(failedDetail.ruleSnapshot) as {
    bodyStageRequired?: boolean;
    rules?: Array<{ topic: string; topicCategory?: string }>;
  };
  expect(failedDetail.bodyStatus).toBe("UNKNOWN");
  expect(failedDetail.autoStatus).toBe("NEEDS_REVIEW");
  expect(failedSnapshot.bodyStageRequired).toBe(false);
  expect(
    failedSnapshot.rules?.some(
      (rule) =>
        rule.topicCategory === "PRODUCT_STAGE" &&
        rule.topic === "#二段奶粉推荐",
    ),
  ).toBe(true);
  await page.goto(`/results/${failedResult!.id}`);
  const bodyAuditCard = page
    .getByRole("heading", { name: "正文审核" })
    .locator("..");
  await expect(bodyAuditCard.getByText("待人工确认", { exact: true })).toBeVisible();
  await expect(
    page.getByText("未提取到正文 / 待人工确认", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("正文段位校验", { exact: true })).toHaveCount(0);
  await expect(page.getByText("不参与审核", { exact: true })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("IFFO：P段/1段");
  await expect(page.locator("body")).not.toContainText("IFFO：2段");
  const imageStateBatchResponse = await page.request.post(
    "/api/automation/batches",
    {
      data: {
        name: "E2E 图片数量状态",
        productId: product.id,
        campaignId: campaign.id,
        productStage: "IFFO_2",
        urls: [
          `${E2E_ORIGIN}/mock/xhs?case=few-images&image-state=${suffix}`,
          `${E2E_ORIGIN}/mock/xhs?case=no-images&image-state=${suffix}`,
          `${E2E_ORIGIN}/mock/xhs?case=live-photo&image-state=${suffix}`,
          `${E2E_ORIGIN}/mock/xhs?case=video-note&image-state=${suffix}`,
        ],
      },
    },
  );
  const imageStateBatchId = (await imageStateBatchResponse.json()).data
    .batchId as string;
  await waitForBatch(page, imageStateBatchId, ["COMPLETED"]);
  const imageStateResults = (
    await (
      await page.request.get(`/api/results?keyword=image-state%3D${suffix}`)
    ).json()
  ).data.items as Array<{
    id: string;
    noteType: string;
    imageStatus: string;
    autoStatus: string;
    imageCount: number;
    failureReasons: string;
    note: { url: string };
  }>;
  expect(
    imageStateResults.find((item) => item.note.url.includes("few-images"))
      ?.imageStatus,
  ).toBe("NON_COMPLIANT");
  expect(
    imageStateResults.find((item) => item.note.url.includes("no-images"))
      ?.imageStatus,
  ).toBe("IMAGES_READ_FAILED");
  expect(
    imageStateResults.find((item) => item.note.url.includes("no-images"))
      ?.failureReasons,
  ).not.toContain("图片");
  expect(
    imageStateResults.find((item) => item.note.url.includes("video-note"))
      ?.imageStatus,
  ).toBe("VIDEO_NOTE");
  const livePhotoResult = imageStateResults.find((item) =>
    item.note.url.includes("live-photo"),
  );
  expect(livePhotoResult).toMatchObject({
    noteType: "IMAGE_TEXT",
    imageStatus: "COMPLIANT",
    imageCount: 3,
  });
  expect(livePhotoResult?.failureReasons).not.toContain("图片数量");

  await page.goto("/results");
  const livePhotoRow = page.locator(
    `.ant-table-row[data-row-key="${livePhotoResult!.id}"]`,
  );
  await expect(livePhotoRow).toContainText("3 张");
  await expect(livePhotoRow).toContainText("数量合规");
  await expect(livePhotoRow).not.toContainText("视频笔记");
  await expect(livePhotoRow).not.toContainText("不参与图片数量判断");

  await page.goto(`/results/${livePhotoResult!.id}`);
  await expect(page.getByText("3 张", { exact: true }).first()).toBeVisible();
  await expect(
    page.getByText("数量合规", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText("视频笔记", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("不参与图片数量判断", { exact: true }),
  ).toHaveCount(0);

  const pauseSuffix = `${suffix}-pause`;
  const pauseBatchResponse = await page.request.post("/api/automation/batches", {
    data: {
      name: "E2E 暂停继续",
      productId: product.id,
      campaignId: campaign.id,
      productStage: "IFFO_2",
      urls: Array.from(
        { length: 3 },
        (_item, index) =>
          `${E2E_ORIGIN}/mock/xhs?case=passed&autoDelay=2000&e2e=${pauseSuffix}-${index}`,
      ),
    },
  });
  const pauseBatchId = (await pauseBatchResponse.json()).data.batchId as string;
  await expect
    .poll(async () => {
      const batches = (await (await page.request.get("/api/automation/batches")).json())
        .data;
      return batches.find((item: { id: string }) => item.id === pauseBatchId)
        ?.stats.processing;
    })
    .toBe(1);
  await page.request.post(`/api/automation/batches/${pauseBatchId}/control`, {
    data: { action: "PAUSE" },
  });
  await expect
    .poll(async () => {
      const batches = (await (await page.request.get("/api/automation/batches")).json())
        .data;
      return batches.find((item: { id: string }) => item.id === pauseBatchId)
        ?.status;
    })
    .toBe("PAUSED");
  await page.request.post(`/api/automation/batches/${pauseBatchId}/control`, {
    data: { action: "CONTINUE" },
  });
  const continuedBatch = await waitForBatch(page, pauseBatchId, ["COMPLETED"]);
  expect(continuedBatch.stats.succeeded).toBe(3);

  const retryBatchResponse = await page.request.post("/api/automation/batches", {
    data: {
      name: "E2E 失败重试",
      productId: product.id,
      campaignId: campaign.id,
      productStage: "IFFO_2",
      urls: `${E2E_ORIGIN}/mock/xhs?case=read-failed&retryCase=passed&e2e-retry=${suffix}`,
    },
  });
  const retryBatchId = (await retryBatchResponse.json()).data.batchId as string;
  const initiallyFailed = await waitForBatch(page, retryBatchId, [
    "COMPLETED_WITH_ERRORS",
  ]);
  expect(initiallyFailed.tasks[0].failureCode).toBe("PAGE_READ_FAILED");
  await page.request.post(`/api/automation/batches/${retryBatchId}/control`, {
    data: { action: "RETRY_FAILED" },
  });
  const retriedBatch = await waitForBatch(page, retryBatchId, ["COMPLETED"]);
  expect(retriedBatch.tasks[0].attempts).toBe(2);
  expect(retriedBatch.tasks[0].auditResults.length).toBe(1);
  const retryHistory = (
    await (
      await page.request.get(
        `/api/results?${new URLSearchParams({ batchId: retryBatchId })}`,
      )
    ).json()
  ).data;
  expect(retryHistory.total).toBe(2);

  const extensionUrl = `${E2E_ORIGIN}/mock/xhs?case=unclickable-topic&extension=${suffix}`;
  const extensionTaskResponse = await page.request.post("/api/tasks", {
    data: {
      urls: extensionUrl,
      productId: product.id,
      campaignId: campaign.id,
      productStage: "IFFO_2",
      notes: "Extension E2E",
    },
  });
  const extensionTask = (await extensionTaskResponse.json()).data.created[0] as { id: string };
  const extraction = createMockNote("unclickable-topic");
  extraction.url = extensionUrl;
  const extensionHealthResponse = await page.request.get("/api/extension/health", {
    headers: { "X-Extension-Token": "local-extension-demo-token" },
  });
  expect(extensionHealthResponse.ok()).toBeTruthy();
  expect(extensionHealthResponse.headers()["access-control-allow-origin"]).toBe("*");

  const invalidExtensionHealthResponse = await page.request.get(
    "/api/extension/health",
    { headers: { "X-Extension-Token": "acceptance-invalid-token" } },
  );
  expect(invalidExtensionHealthResponse.status()).toBe(401);
  expect(
    invalidExtensionHealthResponse.headers()["access-control-allow-origin"],
  ).toBe("*");

  const extensionResponse = await page.request.post("/api/extension/submit", {
    headers: { "X-Extension-Token": "local-extension-demo-token" },
    data: { taskId: extensionTask.id, extraction },
  });
  expect(extensionResponse.ok()).toBeTruthy();
  expect(extensionResponse.headers()["access-control-allow-origin"]).toBe("*");
  expect((await extensionResponse.json()).data.autoStatus).toBe("FAILED");

  const sharedDiscoveryUrl =
    "https://www.xiaohongshu.com/discovery/item/6a4867200000000011007d92?source=webshare&xhsshare=pc_web&xsec_token=e2e-token=&xsec_source=pc_share";
  const sharedExploreUrl =
    "https://www.xiaohongshu.com/explore/6a461e7600000000160272d2?xsec_token=e2e-app-token=&shareRedId=e2e-red&share_id=e2e-share&appuid=e2e-user&xhsshare=CopyLink";
  const linkFormatResponse = await page.request.post("/api/automation/batches", {
    data: {
      name: "E2E 小红书分享链接识别",
      productId: product.id,
      campaignId: campaign.id,
      productStage: "IFFO_2",
      urls: [
        `标题 + 分享码 ABC123 ${sharedDiscoveryUrl}`,
        sharedExploreUrl,
        "App 分享 http://xhslink.com/o/e2e-short 复制后打开小红书",
        "http://xhslink.cn/o/e2e-short-cn",
        `重复 ${sharedDiscoveryUrl}`,
        "无效说明文字",
      ].join("\n"),
    },
  });
  expect(linkFormatResponse.ok()).toBeTruthy();
  const linkFormat = (await linkFormatResponse.json()).data as {
    batchId: string;
    created: number;
    recognizedCount: number;
    deduplicatedCount: number;
    duplicateCount: number;
    unrecognized: Array<{ reason: string }>;
  };
  expect(linkFormat).toMatchObject({
    created: 4,
    recognizedCount: 5,
    deduplicatedCount: 4,
    duplicateCount: 1,
  });
  expect(linkFormat.unrecognized).toEqual(
    expect.arrayContaining([expect.objectContaining({ reason: "未识别到链接" })]),
  );
  await page.request.post(`/api/automation/batches/${linkFormat.batchId}/control`, {
    data: { action: "CANCEL" },
  });
  const linkBatch = (
    (await (await page.request.get("/api/automation/batches")).json()).data as Array<{
      id: string;
      tasks: Array<{ url: string; originalInput?: string | null }>;
    }>
  ).find((item) => item.id === linkFormat.batchId);
  expect(linkBatch?.tasks.map((task) => task.url)).toEqual(
    expect.arrayContaining([
      sharedDiscoveryUrl,
      sharedExploreUrl,
      "http://xhslink.com/o/e2e-short",
      "http://xhslink.cn/o/e2e-short-cn",
    ]),
  );
  expect(linkBatch?.tasks.every((task) => task.originalInput?.includes("ABC123"))).toBe(
    true,
  );
});
