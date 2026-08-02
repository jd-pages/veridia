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
          stats: Record<string, number>;
          tasks: Array<{
            status: string;
            attempts: number;
            failureCode: string | null;
            auditResults: Array<{ id: string }>;
          }>;
        }>;
        const batch = batches.find((item) => item.id === batchId);
        return batch && terminalStatuses.includes(batch.status) ? batch : null;
      },
      { timeout: 30_000 },
    )
    .not.toBeNull()
    .then(async () => {
      const response = await page.request.get("/api/automation/batches");
      const batches = (await response.json()).data;
      return batches.find((item: { id: string }) => item.id === batchId);
    });
}

test("本地账号登录、创建任务、审核、详情、Excel 与插件提交链路", async ({ page }) => {
  test.setTimeout(120_000);
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
  expect(afterRules.counts).toEqual({
    products: 5,
    activities: 1,
    stageGroups: 3,
    topicRules: 9,
  });

  const productsResponse = await page.request.get("/api/products");
  expect(productsResponse.ok()).toBeTruthy();
  const products = (await productsResponse.json()).data as Array<{ id: string; code: string; name: string }>;
  const product =
    products.find((item) => item.name.includes("澳洲白金版")) ||
    products[0];
  expect(product).toBeTruthy();
  const campaignsResponse = await page.request.get(`/api/campaigns?productId=${product.id}`);
  const campaign = ((await campaignsResponse.json()).data as Array<{ id: string; name: string; month: string }>)[0];
  expect(campaign).toBeTruthy();

  const ruleTemplateBuffer = await readFile(
    "templates/活动规则标准导入模板.xlsx",
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
    };
  };
  expect(rulePreview.campaign.customerRegistrationNotes).toMatch(
    /图片.*不参与自动审核/u,
  );
  expect(rulePreview.campaign.minImageCount).toBe(2);

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
  expect(auditResponse.ok()).toBeTruthy();
  const auditResult = (await auditResponse.json()).data as {
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
    /VERIDIA%E5%AE%A1%E6%A0%B8%E7%BB%93%E6%9E%9C_%E5%BD%93%E5%89%8D%E7%AD%9B%E9%80%89_\d{4}-\d{2}-\d{2}\.xlsx/u,
  );
  const exportWorkbook = new ExcelJS.Workbook();
  await exportWorkbook.xlsx.load(
    (await exportResponse.body()) as unknown as ExcelJS.Buffer,
  );
  const exportHeaders = worksheetHeaders(exportWorkbook.worksheets[0]);
  expect(exportHeaders).toContain("图片数量");
  expect(exportHeaders).toContain("图片提取状态");
  expect(exportHeaders).toContain("图片数量合规");
  expect(exportHeaders).toContain("产品阶段话题");
  expect(exportHeaders).toContain("正文允许段位");
  expect(exportHeaders).toContain("正文实际识别段位");
  expect(exportHeaders).toContain("要求阶段话题");
  expect(exportHeaders).toContain("任务来源");
  expect(exportHeaders).not.toContain("图片URL");
  const exportSheet = exportWorkbook.worksheets[0];
  expect(exportSheet.rowCount - 1).toBe(
    Number(exportResponse.headers()["x-veridia-export-count"]),
  );
  expect(exportSheet.rowCount).toBeGreaterThan(1);
  const resultColumn = exportHeaders.indexOf("审核结果") + 1;
  const sourceColumn = exportHeaders.indexOf("任务来源") + 1;
  const exportedStatuses = exportSheet
    .getColumn(resultColumn)
    .values.slice(2)
    .map(String);
  const exportedSources = exportSheet
    .getColumn(sourceColumn)
    .values.slice(2)
    .map(String);
  expect(exportedStatuses).not.toContain("PASSED");
  expect(exportedStatuses).toHaveLength(1);
  expect(exportedStatuses[0]).toMatch(/审核通过|审核不通过|待人工复核/u);
  expect(exportedSources).not.toContain("MANUAL");

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
  const csvExport = await csvExportResponse.body();
  expect(csvExport[0]).toBe(0xef);
  expect(csvExport[1]).toBe(0xbb);
  expect(csvExport[2]).toBe(0xbf);
  expect(csvExport.toString("utf8")).toContain("审核结果");

  const taskExportResponse = await page.request.get(
    "/api/tasks/export?format=xlsx",
  );
  expect(taskExportResponse.ok()).toBeTruthy();

  const noteTemplateResponse = await page.request.get("/api/import/template");
  expect(noteTemplateResponse.ok()).toBeTruthy();
  const noteTemplateWorkbook = new ExcelJS.Workbook();
  await noteTemplateWorkbook.xlsx.load(
    (await noteTemplateResponse.body()) as unknown as ExcelJS.Buffer,
  );
  const noteTemplateHeaders = worksheetHeaders(
    noteTemplateWorkbook.worksheets[0],
  );
  expect(noteTemplateHeaders).toContain("产品阶段话题");
  expect(noteTemplateHeaders.some((header) => header.includes("图片数量"))).toBe(
    true,
  );

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
    "备注",
  ]);
  sheet.addRow([
    `标题 + ${E2E_ORIGIN}/mock/xhs?case=no-images&e2e-import=${suffix} + 说明文字`,
    product.code,
    product.name,
    campaign.name,
    campaign.month,
    "2段",
    "小红书",
    "E2E Excel 无图片但继续审核",
  ]);
  const hyperlinkImportRow = sheet.addRow([
    "点击打开小红书笔记",
    product.code,
    product.name,
    campaign.name,
    campaign.month,
    "2段",
    "小红书",
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
    "2段",
    "",
    "E2E Excel 后续成功",
  ]);
  sheet.addRow([
    "https://www.douyin.com/video/123456",
    product.code,
    product.name,
    campaign.name,
    campaign.month,
    "2段",
    "抖音",
    "E2E 不支持平台不影响其他行",
  ]);
  const excel = Buffer.from(await workbook.xlsx.writeBuffer());
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
    rows: Array<{
      originalLinkContent: string;
      url: string;
      recognitionStatus: string;
      failureReason: string;
    }>;
  };
  expect(importPreview.validCount).toBe(3);
  expect(importPreview.invalidCount).toBe(1);
  expect(importPreview.rows[0].url).toContain("case=no-images");
  expect(importPreview.rows[0].originalLinkContent).toContain("标题 +");
  expect(importPreview.rows[1]).toMatchObject({
    originalLinkContent: "点击打开小红书笔记",
    recognitionStatus: "RECOGNIZED",
  });
  expect(importPreview.rows[1].url).toContain("case=read-failed");
  expect(importPreview.rows[3]).toMatchObject({
    recognitionStatus: "UNSUPPORTED",
    failureReason: "内容渠道为抖音，暂不支持小红书自动审核",
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
  };
  expect(committedImport.imported).toBe(3);
  const excelBatch = await waitForBatch(page, committedImport.batchId, [
    "COMPLETED_WITH_ERRORS",
  ]);
  expect(excelBatch.stats.succeeded).toBe(2);
  expect(excelBatch.stats.failed).toBe(1);
  expect(excelBatch.stats.progress).toBe(100);

  const resultCoverageSuffix = `${suffix}-result-coverage`;
  const resultCoverageBatchResponse = await page.request.post(
    "/api/automation/batches",
    {
      data: {
        name: "E2E 失败结果完整落库",
        productId: product.id,
        campaignId: campaign.id,
        productStage: "IFFO_2",
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
    status: "PROCESS_FAILED",
    manualStatus: "PENDING",
    pageStatus: failedSample.pageStatus,
    bodyStatus: failedSample.bodyStatus,
    topicsStatus: failedSample.topicsCompliant
      ? "COMPLIANT"
      : "NON_COMPLIANT",
    clickableStatus: failedSample.clickableCompliant
      ? "COMPLIANT"
      : "NON_COMPLIANT",
    imageStatus: failedSample.imageStatus,
    noteType: failedSample.noteType,
    reason: "人工确认",
    ruleVersion: String(failedSample.ruleVersion),
    publicStatus: failedSample.publicStatus,
    retentionStatus: failedSample.retentionStatus,
    keyword: `result-coverage=${resultCoverageSuffix}`,
    format: "csv",
  });
  const failureExportResponse = await page.request.get(
    `/api/results/export?${fullFilterExportQuery}`,
  );
  expect(failureExportResponse.ok()).toBeTruthy();
  const failureExportCsv = await failureExportResponse.text();
  expect(failureExportCsv).toContain("处理状态");
  expect(failureExportCsv).toContain("审核结果");
  expect(failureExportCsv).toContain("异常分类");
  expect(failureExportCsv).toContain("失败原因");
  expect(failureExportCsv).toContain("是否需要人工复核");
  expect(failureExportCsv).toContain("人工复核状态");
  expect(failureExportCsv).toContain("审核创建时间");
  expect(failureExportCsv).toContain("审核完成时间");
  expect(failureExportCsv).toContain("任务创建时间");
  expect(failureExportCsv).toContain("发布时间");
  expect(failureExportCsv).toContain("日期筛选口径");
  expect(failureExportCsv).toContain(`${resultCoverageSuffix}-failed-1`);
  expect(failureExportCsv).toContain(`${resultCoverageSuffix}-failed-2`);
  expect(failureExportCsv).toContain("待人工复核");

  await page.goto("/tasks");
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
  await expect(
    page.getByText("未提取到正文 / 待人工确认").first(),
  ).toBeVisible();
  await expect(page.getByText("正文段位校验", { exact: true })).toHaveCount(0);
  await expect(page.getByText("不参与审核", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("#二段奶粉推荐", { exact: true }).first(),
  ).toBeVisible();
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
