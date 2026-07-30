import { expect, test, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { readFile } from "node:fs/promises";
import { createMockNote } from "../../lib/mock-data";

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

test("本地免登录、创建任务、审核、详情、Excel 与插件提交链路", async ({ page }) => {
  await page.goto("/login");
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByLabel("用户名")).toHaveCount(0);
  await expect(page.getByLabel("密码")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "审核工作台" })).toBeVisible();

  const ruleStatusBefore = await page.request.get("/api/rule-sync/status");
  expect(ruleStatusBefore.ok()).toBeTruthy();
  const beforeRules = (await ruleStatusBefore.json()).data;
  expect(beforeRules.currentVersion).toBeTruthy();
  expect(beforeRules.counts.products).toBeGreaterThan(0);
  const appliedRuleSync = await page.request.post("/api/rule-sync/apply");
  expect(appliedRuleSync.ok()).toBeTruthy();
  const ruleStatusAfter = await page.request.get("/api/rule-sync/status");
  const afterRules = (await ruleStatusAfter.json()).data;
  expect(afterRules.currentVersion).toBe("rules-2026.07.29.1");
  expect(afterRules.source).toBe("GITHUB");
  expect(afterRules.counts).toEqual({
    products: 5,
    activities: 1,
    stageGroups: 3,
    topicRules: 9,
  });

  const productsResponse = await page.request.get("/api/products");
  expect(productsResponse.ok()).toBeTruthy();
  const products = (await productsResponse.json()).data as Array<{ id: string; code: string; name: string }>;
  const product = products[0];
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
  const taskUrl = `http://localhost:3100/mock/xhs?case=passed&e2e=${suffix}`;
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

  const exportResponse = await page.request.get("/api/results/export?status=PASSED");
  expect(exportResponse.ok()).toBeTruthy();
  expect(exportResponse.headers()["content-type"]).toContain(
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
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
  expect(exportedStatuses.every((value) => value === "审核通过")).toBeTruthy();
  expect(exportedSources).not.toContain("MANUAL");

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
  expect(noteTemplateHeaders.some((header) => header.includes("图片"))).toBe(
    false,
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
    "备注",
  ]);
  sheet.addRow([
    `http://localhost:3100/mock/xhs?case=no-images&e2e-import=${suffix}`,
    product.code,
    product.name,
    campaign.name,
    campaign.month,
    "2段",
    "E2E Excel 无图片但继续审核",
  ]);
  sheet.addRow([
    `http://localhost:3100/mock/xhs?case=read-failed&e2e-import=${suffix}-failure`,
    product.code,
    product.name,
    campaign.name,
    campaign.month,
    "2段",
    "E2E Excel 单条失败",
  ]);
  sheet.addRow([
    `http://localhost:3100/mock/xhs?case=passed&e2e-import=${suffix}-after-failure`,
    product.code,
    product.name,
    campaign.name,
    campaign.month,
    "2段",
    "E2E Excel 后续成功",
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
  expect((await importResponse.json()).data.validCount).toBe(3);

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

  const imageStateBatchResponse = await page.request.post(
    "/api/automation/batches",
    {
      data: {
        name: "E2E 图片数量状态",
        productId: product.id,
        campaignId: campaign.id,
        productStage: "IFFO_2",
        urls: [
          `http://localhost:3100/mock/xhs?case=few-images&image-state=${suffix}`,
          `http://localhost:3100/mock/xhs?case=no-images&image-state=${suffix}`,
          `http://localhost:3100/mock/xhs?case=video-note&image-state=${suffix}`,
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
          `http://localhost:3100/mock/xhs?case=passed&autoDelay=2000&e2e=${pauseSuffix}-${index}`,
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
      urls: `http://localhost:3100/mock/xhs?case=read-failed&retryCase=passed&e2e-retry=${suffix}`,
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

  const extensionUrl = `http://localhost:3100/mock/xhs?case=unclickable-topic&extension=${suffix}`;
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
});
