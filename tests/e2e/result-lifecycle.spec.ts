import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import ExcelJS from "exceljs";
import path from "node:path";
import { E2E_ORIGIN } from "./e2e-origin";

const databaseUrl =
  process.env.E2E_DATABASE_URL?.trim() ||
  `file:${path.resolve(process.cwd(), "prisma", "e2e.db").replaceAll("\\", "/")}`;

async function login(page: Page) {
  const response = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(response.ok()).toBeTruthy();
}

async function waitForBatch(page: Page, batchId: string) {
  await expect.poll(async () => {
    const payload = await (
      await page.request.get(`/api/automation/batches?batchId=${batchId}`)
    ).json();
    return payload.data[0]?.status;
  }, { timeout: 120_000 }).toMatch(/^(?:COMPLETED|COMPLETED_WITH_ERRORS)$/u);
}

test("删除当前审核结果后同日重新导入立即释放单条重复占用", async ({ page }) => {
  await login(page);
  const products = (await (await page.request.get("/api/products")).json())
    .data as Array<{ id: string; name: string }>;
  const product = products.find((item) => item.name.includes("澳洲白金版"))!;
  const campaigns = (await (
    await page.request.get(
      `/api/campaigns?productId=${product.id}&contentChannel=XIAOHONGSHU`,
    )
  ).json()).data as Array<{ id: string; name: string }>;
  const campaign = campaigns.find((item) =>
    item.name.includes("爱他美2026年7月"),
  )!;
  const suffix = Date.now();
  const url = `${E2E_ORIGIN}/mock/xhs?case=passed&delete-release=${suffix}`;
  const createdResponse = await page.request.post("/api/tasks", {
    data: {
      urls: url,
      productId: product.id,
      campaignId: campaign.id,
      productStage: "IFFO",
    },
  });
  expect(createdResponse.ok()).toBeTruthy();
  const task = (await createdResponse.json()).data.created[0] as { id: string };
  const auditedResponse = await page.request.post(`/api/tasks/${task.id}/audit`, {
    data: {
      extraction: {
        url,
        finalUrl: url,
        pageTitle: "删除后重新导入测试",
        pageType: "NOTE_DETAIL",
        noteId: `delete-release-${suffix}`,
        title: "删除后重新导入测试",
        body: "这是一段用于验证结果删除后立即释放同日重复占用的完整正文内容。".repeat(3),
        noteType: "IMAGE_TEXT",
        imageExtractionStatus: "SUCCESS",
        imageCount: 2,
        topics: [],
        pageStatus: "NORMAL",
        authorName: "测试作者",
        publishedAt: null,
        isPublic: true,
        extractedAt: new Date().toISOString(),
        adapterName: "e2e",
        adapterVersion: "1.0.0",
      },
    },
  });
  expect(auditedResponse.ok()).toBeTruthy();
  const result = (await auditedResponse.json()).data as { id: string };

  const blocked = await page.request.post("/api/tasks", {
    data: { urls: url, productId: product.id, campaignId: campaign.id, productStage: "IFFO" },
  });
  expect(blocked.ok()).toBeTruthy();
  expect((await blocked.json()).data).toMatchObject({ created: [], errors: [expect.objectContaining({ url })] });

  expect((await page.request.delete(`/api/results/${result.id}`)).ok()).toBeTruthy();
  const allowed = await page.request.post("/api/tasks", {
    data: { urls: url, productId: product.id, campaignId: campaign.id, productStage: "IFFO" },
  });
  expect(allowed.ok()).toBeTruthy();
  const allowedPayload = (await allowed.json()).data as {
    created: Array<{ id: string }>;
  };
  try {
    expect(allowedPayload.created).toHaveLength(1);
  } finally {
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    try {
      await prisma.auditTask.deleteMany({
        where: { id: { in: allowedPayload.created.map(({ id }) => id) } },
      });
    } finally {
      await prisma.$disconnect();
    }
  }
});

test("重新审核保留历史版本并在原始导入槽位原位替换", async ({ page }) => {
  test.setTimeout(300_000);
  await login(page);
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  const createdBatchIds: string[] = [];
  let importRecordId: string | null = null;
  let storeTopicRuleId: string | null = null;
  try {
    const products = (await (await page.request.get("/api/products")).json())
      .data as Array<{ id: string; name: string }>;
    const product = products.find((item) => item.name === "爱他美澳洲白金版")!;
    expect(product).toBeTruthy();
    const campaigns = (await (
      await page.request.get(`/api/campaigns?productId=${product.id}`)
    ).json()).data as Array<{
      id: string;
      name: string;
      month: string;
      contentChannel: string;
    }>;
    const xhsCampaign = campaigns.find(
      (item) =>
        item.month === "2026-07" && item.contentChannel === "XIAOHONGSHU",
    )!;
    const douyinCampaign = campaigns.find(
      (item) => item.month === "2026-07" && item.contentChannel === "DOUYIN",
    )!;
    expect(xhsCampaign).toBeTruthy();
    expect(douyinCampaign).toBeTruthy();

    const suffix = Date.now();
    const storeName = `结果槽位ROCKCHECK${suffix}海外专营店`;
    const storeRuleResponse = await page.request.post("/api/store-topic-rules", {
      data: {
        commercePlatform: "TMALL",
        storeName,
        enabled: true,
        acceptedTopics: [
          { topic: storeName },
          { topic: "ROCKCHECK海外旗舰店" },
        ],
        requiredTopics: [{ topic: "天猫" }],
      },
    });
    const storeRulePayload = await storeRuleResponse.json();
    expect(
      storeRuleResponse.ok(),
      JSON.stringify(storeRulePayload),
    ).toBeTruthy();
    storeTopicRuleId = storeRulePayload.data.id;
    const orderNumbers = {
      first: `SLOT-01-${suffix}`,
      second: `SLOT-02-${suffix}`,
      third: `SLOT-03-${suffix}`,
      douyin: `SLOT-04-${suffix}`,
    };
    const xhsPassedUrl = (marker: string) =>
      `${E2E_ORIGIN}/mock/xhs?case=aptamil-stage2-rockcheck-store-passed&result-slot=${suffix}-${marker}`;
    const xhsFailedUrl =
      `${E2E_ORIGIN}/mock/xhs?case=no-topics&result-slot=${suffix}-failed`;
    const douyinUrl =
      `${E2E_ORIGIN}/mock/douyin?case=video&topic=${encodeURIComponent("ROCKCHECK海外专营店")}&result-slot=${suffix}-douyin`;

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("结果槽位");
    sheet.addRow([
      "平台（必填）",
      "店铺名称（必填）",
      "客户名（必填）",
      "产品系列（必填）",
      "段位（必填）",
      "订单编号（必填）",
      "内容渠道（必填）",
      "链接（必填）",
      "发布时间（必填）",
      "活动名称（必填）",
    ]);
    const common = ["天猫", storeName];
    sheet.addRow([
      ...common,
      "结果槽位01",
      "澳白2",
      "IFFO",
      orderNumbers.first,
      "小红书",
      xhsPassedUrl("first"),
      "2026-07-26 12:00:00",
      xhsCampaign.name,
    ]);
    sheet.addRow([
      ...common,
      "结果槽位02",
      "澳白2",
      "IFFO",
      orderNumbers.second,
      "小红书",
      xhsFailedUrl,
      "2026-07-26 12:01:00",
      xhsCampaign.name,
    ]);
    sheet.addRow([
      ...common,
      "结果槽位03",
      "澳白2",
      "IFFO",
      orderNumbers.third,
      "小红书",
      xhsPassedUrl("third"),
      "2026-07-26 12:02:00",
      xhsCampaign.name,
    ]);
    sheet.addRow([
      ...common,
      "结果槽位04",
      "澳白2",
      "IFFO",
      orderNumbers.douyin,
      "抖音",
      douyinUrl,
      "2026-07-26 12:03:00",
      douyinCampaign.name,
    ]);
    const metadata = workbook.addWorksheet("VERIDIA模板信息", {
      state: "veryHidden",
    });
    metadata.getCell("B1").value = "DANONE_AGENCY";

    const importResponse = await page.request.post("/api/import/notes", {
      multipart: {
        file: {
          name: `result-slot-${suffix}.xlsx`,
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
        },
        commit: "true",
        skipDuplicates: "true",
      },
    });
    const importPayload = await importResponse.json();
    expect(importResponse.ok(), JSON.stringify(importPayload)).toBeTruthy();
    expect(importPayload.data).toMatchObject({
      validCount: 4,
      invalidCount: 0,
      plannedBatchCount: 2,
    });
    importRecordId = importPayload.data.importRecordId;
    createdBatchIds.push(...importPayload.data.batchIds);
    for (const batchId of importPayload.data.batchIds as string[]) {
      await waitForBatch(page, batchId);
    }

    const readImportResults = async (extra = "") => {
      const response = await page.request.get(
        `/api/results?importRecordId=${importRecordId}&pageSize=100${extra}`,
      );
      expect(response.ok()).toBeTruthy();
      return (await response.json()).data as {
        total: number;
        items: Array<{
          id: string;
          originTaskId: string;
          resultSlotOrder: number;
          autoStatus: string;
          manualReviews: unknown[];
          task: {
            id: string;
            orderNumber: string;
            channel: string;
            replacesResultId: string | null;
          };
        }>;
      };
    };
    const initial = await readImportResults();
    expect(initial.total).toBe(4);
    expect(initial.items.map((item) => item.task.orderNumber)).toEqual(
      Object.values(orderNumbers),
    );
    const originalSecond = initial.items.find(
      (item) => item.task.orderNumber === orderNumbers.second,
    )!;
    expect(originalSecond.autoStatus).toBe("NEEDS_REVIEW");

    const manualReview = await page.request.post(
      `/api/results/${originalSecond.id}/review`,
      { data: { result: "FAILED", comment: "旧版本人工复核" } },
    );
    expect(manualReview.ok()).toBeTruthy();
    const repairedUrl = xhsPassedUrl("second-repaired");
    await prisma.auditTask.update({
      where: { id: originalSecond.task.id },
      data: { url: repairedUrl, normalizedUrl: repairedUrl },
    });

    let currentSecondId = originalSecond.id;
    for (let index = 0; index < 3; index += 1) {
      const response = await page.request.post("/api/results/bulk", {
        data: { ids: [currentSecondId], action: "RE_AUDIT" },
      });
      const payload = await response.json();
      expect(response.ok(), JSON.stringify(payload)).toBeTruthy();
      createdBatchIds.push(payload.data.batchId);
      await waitForBatch(page, payload.data.batchId);
      const current = await readImportResults();
      expect(current.total).toBe(4);
      expect(current.items.map((item) => item.task.orderNumber)).toEqual(
        Object.values(orderNumbers),
      );
      const latest = current.items.find(
        (item) => item.task.orderNumber === orderNumbers.second,
      )!;
      expect(latest.id).not.toBe(currentSecondId);
      expect(latest.task.replacesResultId).toBe(currentSecondId);
      expect(latest.resultSlotOrder).toBe(originalSecond.resultSlotOrder);
      currentSecondId = latest.id;
    }

    const currentAfterThree = await readImportResults();
    const latestSecond = currentAfterThree.items.find(
      (item) => item.task.orderNumber === orderNumbers.second,
    )!;
    expect(latestSecond.autoStatus).toBe("PASSED");
    expect(latestSecond.manualReviews).toHaveLength(0);
    const failedFilter = await readImportResults("&status=NEEDS_REVIEW");
    expect(
      failedFilter.items.some(
        (item) => item.task.orderNumber === orderNumbers.second,
      ),
    ).toBe(false);
    const passedFilter = await readImportResults("&status=PASSED");
    expect(
      passedFilter.items.some(
        (item) => item.task.orderNumber === orderNumbers.second,
      ),
    ).toBe(true);

    const oldDetail = await (
      await page.request.get(`/api/results/${originalSecond.id}`)
    ).json();
    expect(oldDetail.data).toMatchObject({
      isCurrent: false,
      latestResultId: latestSecond.id,
    });
    expect(oldDetail.data.manualReviews).toHaveLength(1);
    expect(
      await prisma.auditResult.count({
        where: { originTaskId: originalSecond.originTaskId },
      }),
    ).toBe(4);
    expect(
      await prisma.auditResult.count({
        where: {
          originTaskId: originalSecond.originTaskId,
          supersededAt: null,
        },
      }),
    ).toBe(1);

    const first = currentAfterThree.items.find(
      (item) => item.task.orderNumber === orderNumbers.first,
    )!;
    const third = currentAfterThree.items.find(
      (item) => item.task.orderNumber === orderNumbers.third,
    )!;
    const bulkResponse = await page.request.post("/api/results/bulk", {
      data: { ids: [third.id, first.id], action: "RE_AUDIT" },
    });
    const bulkPayload = await bulkResponse.json();
    expect(bulkResponse.ok(), JSON.stringify(bulkPayload)).toBeTruthy();
    createdBatchIds.push(bulkPayload.data.batchId);
    await waitForBatch(page, bulkPayload.data.batchId);

    const douyin = (await readImportResults()).items.find(
      (item) => item.task.orderNumber === orderNumbers.douyin,
    )!;
    const douyinResponse = await page.request.post("/api/results/bulk", {
      data: { ids: [douyin.id], action: "RE_AUDIT" },
    });
    const douyinPayload = await douyinResponse.json();
    expect(douyinResponse.ok(), JSON.stringify(douyinPayload)).toBeTruthy();
    createdBatchIds.push(douyinPayload.data.batchId);
    await waitForBatch(page, douyinPayload.data.batchId);

    const finalResults = await readImportResults();
    expect(finalResults.total).toBe(4);
    expect(finalResults.items.map((item) => item.task.orderNumber)).toEqual(
      Object.values(orderNumbers),
    );
    expect(
      finalResults.items.find(
        (item) => item.task.orderNumber === orderNumbers.douyin,
      )!.id,
    ).not.toBe(douyin.id);

    const exportResponse = await page.request.get(
      `/api/results/export?importRecordId=${importRecordId}`,
    );
    expect(exportResponse.ok()).toBeTruthy();
    expect(exportResponse.headers()["x-veridia-export-count"]).toBe("4");
    const exported = new ExcelJS.Workbook();
    await exported.xlsx.load(
      (await exportResponse.body()) as unknown as ExcelJS.Buffer,
    );
    const resultSheet = exported.worksheets.find((candidate) => {
      const headers = candidate.getRow(1).values as unknown[];
      return headers.includes("订单编号");
    });
    expect(resultSheet).toBeTruthy();
    const headers = resultSheet!.getRow(1).values as unknown[];
    const orderColumn = headers.indexOf("订单编号");
    expect(orderColumn).toBeGreaterThan(0);
    const exportedOrders: string[] = [];
    for (let row = 2; row <= resultSheet!.rowCount; row += 1) {
      exportedOrders.push(String(resultSheet!.getCell(row, orderColumn).value));
    }
    expect(exportedOrders).toEqual(Object.values(orderNumbers));
  } finally {
    if (importRecordId) {
      const results = await prisma.auditResult.findMany({
        where: { task: { importRecordId } },
        select: { id: true },
      });
      const resultIds = results.map((item) => item.id);
      const tasks = await prisma.auditTask.findMany({
        where: { importRecordId },
        select: { id: true },
      });
      const taskIds = tasks.map((item) => item.id);
      await prisma.$transaction([
        prisma.manualReview.deleteMany({
          where: { auditResultId: { in: resultIds } },
        }),
        prisma.ruleResult.deleteMany({
          where: { auditResultId: { in: resultIds } },
        }),
        prisma.auditResult.deleteMany({ where: { id: { in: resultIds } } }),
        prisma.extractionRecord.deleteMany({
          where: { auditTaskId: { in: taskIds } },
        }),
        prisma.auditTask.deleteMany({ where: { id: { in: taskIds } } }),
        prisma.auditBatch.deleteMany({
          where: {
            OR: [
              { importRecordId },
              { id: { in: createdBatchIds } },
            ],
          },
        }),
        prisma.importRecord.deleteMany({ where: { id: importRecordId } }),
      ]);
    }
    await prisma.$disconnect();
    if (storeTopicRuleId) {
      await page.request.delete(`/api/store-topic-rules/${storeTopicRuleId}`);
    }
  }
});
