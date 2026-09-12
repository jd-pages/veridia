import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";
import { prisma } from "../../lib/db";
import { E2E_ORIGIN } from "./e2e-origin";
import { ensureStoreTopicRuleSeeds } from "../../lib/store-topic-rule-service";
import { WYETH_NESTLE_SHEET_NAME } from "../../lib/import-template-type";

test.describe.configure({ mode: "serial" });

test("统一模板下载、惠氏/雀巢四行解析、Sheet 错误与跨 Sheet 重复", async ({ page }) => {
  test.setTimeout(90_000);
  await ensureStoreTopicRuleSeeds();
  const login = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(login.ok()).toBeTruthy();

  const suffix = Date.now().toString(36);
  const products = await Promise.all(
    (["惠氏", "惠氏", "雀巢", "雀巢"] as const).map((brandName, index) =>
      prisma.product.create({
        data: {
          id: `e2e-unified-product-${suffix}-${index}`,
          code: `E2E-UNIFIED-${suffix}-${index}`,
          name: `E2E${brandName}产品${index + 1}-${suffix}`,
          brandName,
        },
      }),
    ),
  );
  const campaigns = await Promise.all(products.map((product, index) =>
    prisma.campaign.create({
      data: {
        id: `e2e-unified-campaign-${suffix}-${index}`,
        name: `E2E统一模板活动${index + 1}-${suffix}`,
        month: "2026-09",
        startDate: new Date("2026-09-01T00:00:00.000Z"),
        endDate: new Date("2026-09-30T23:59:59.999Z"),
        contentChannel: "XIAOHONGSHU",
        productId: product.id,
      },
    }),
  ));
  await prisma.topicRule.createMany({
    data: products.map((product, index) => ({
      id: `e2e-unified-rule-${suffix}-${index}`,
      campaignId: campaigns[index].id,
      productId: product.id,
      brandName: product.brandName,
      contentChannel: "XIAOHONGSHU",
      scope: "CAMPAIGN",
      ruleType: "REQUIRED",
      topic: `#E2E统一模板${index + 1}`,
    })),
  });
  const createdTaskIds: string[] = [];

  try {
    const [wyethStore, nestleStore] = await Promise.all([
      prisma.storeTopicRule.findFirstOrThrow({
        where: { commercePlatform: "JD", enabled: true, deletedAt: null, storeName: { contains: "惠氏" } },
      }),
      prisma.storeTopicRule.findFirstOrThrow({
        where: { commercePlatform: "JD", enabled: true, deletedAt: null, storeName: { contains: "雀巢" } },
      }),
    ]);
    const templateResponse = await page.request.get("/api/import/template?format=xlsx");
    expect(templateResponse.ok()).toBeTruthy();
    expect(decodeURIComponent(templateResponse.headers()["content-disposition"] || ""))
      .toContain("VERIDIA审核导入模板.xlsx");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await templateResponse.body()) as unknown as ExcelJS.Buffer);
    expect(workbook.worksheets.filter((sheet) => sheet.state === "visible").map((sheet) => sheet.name))
      .toEqual(["达能客户导入", "佳贝艾特客户导入", WYETH_NESTLE_SHEET_NAME]);
    const productOptions = workbook.getWorksheet("产品列表")!;
    expect(productOptions.state).toBe("veryHidden");
    expect(productOptions.getColumn(1).values.join("|")).toContain(products[0].name);
    expect(productOptions.getColumn(1).values.join("|")).toContain(products[2].name);

    const shared = workbook.getWorksheet(WYETH_NESTLE_SHEET_NAME)!;
    const urls = products.map((_, index) =>
      `${E2E_ORIGIN}/mock/xhs?case=passed&unified=${suffix}-${index}`,
    );
    products.forEach((product, index) => shared.addRow([
      `登记人${index + 1}`,
      `微信昵称${index + 1}`,
      "京东",
      product.brandName === "惠氏" ? wyethStore.storeName : nestleStore.storeName,
      product.name,
      `ORDER-${suffix}-${index}`,
      "小红书",
      urls[index],
      "2026-09-12 10:00:00",
      index === 0 ? "2026-09-12-已留言" : "",
      "Y",
      "Y",
    ]));
    const previewResponse = await page.request.post("/api/import/notes", {
      multipart: {
        file: {
          name: "VERIDIA审核导入模板.xlsx",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
        },
        commit: "false",
        skipDuplicates: "true",
      },
    });
    const previewPayload = await previewResponse.json();
    expect(previewResponse.ok(), JSON.stringify(previewPayload)).toBeTruthy();
    const preview = previewPayload.data as {
      total: number;
      validCount: number;
      invalidCount: number;
      rows: Array<{
        sheetName: string;
        productId: string;
        campaignId: string;
        matchedStoreName: string;
        contentChannel: string;
        errors: string[];
      }>;
    };
    expect(preview).toMatchObject({ total: 4, validCount: 4, invalidCount: 0 });
    expect(preview.rows.map((row) => row.productId)).toEqual(products.map((product) => product.id));
    expect(preview.rows.map((row) => row.campaignId)).toEqual(campaigns.map((campaign) => campaign.id));
    expect(preview.rows.every((row) => row.sheetName === WYETH_NESTLE_SHEET_NAME)).toBe(true);
    expect(preview.rows.every((row) => row.contentChannel === "小红书")).toBe(true);
    expect(preview.rows.every((row) => row.matchedStoreName)).toBe(true);

    const audit = async (index: number, total: number, includeRequiredTopic: boolean) => {
      const url = `${E2E_ORIGIN}/mock/xhs?case=passed&unified-export=${suffix}-${index}`;
      const create = await page.request.post("/api/tasks", {
        data: {
          urls: url,
          productId: products[index].id,
          campaignId: campaigns[index].id,
          productStage: "IFFO",
          skipDuplicates: true,
        },
      });
      expect(create.ok()).toBeTruthy();
      const task = (await create.json()).data.created[0] as { id: string };
      createdTaskIds.push(task.id);
      const audited = await page.request.post(`/api/tasks/${task.id}/audit`, {
        data: {
          extraction: {
            url,
            finalUrl: url,
            noteId: `unified-export-${suffix}-${index}`,
            title: "统一模板导出验证",
            body: "这是用于验证统一模板导出的真实内容正文。",
            noteType: "IMAGE_TEXT",
            imageExtractionStatus: "SUCCESS",
            imageCount: 2,
            likeCount: total,
            commentCount: 0,
            favoriteCount: 0,
            interactionExtractionStatus: "SUCCESS",
            topics: includeRequiredTopic ? [{
              displayText: `#E2E统一模板${index + 1}`,
              isLinkElement: true,
              hasHref: true,
              href: `${E2E_ORIGIN}/topic/${index}`,
              styleFeature: true,
            }] : [],
            pageStatus: "NORMAL",
            isPublic: true,
            extractedAt: new Date().toISOString(),
            adapterName: "e2e-unified-template",
            adapterVersion: "1.0.0",
          },
        },
      });
      const auditedPayload = await audited.json();
      expect(audited.ok(), JSON.stringify(auditedPayload)).toBeTruthy();
      return auditedPayload.data.id as string;
    };
    const exportCases = [
      [await audit(0, 9, true), "Y", "N"],
      [await audit(1, 10, true), "Y", "Y"],
      [await audit(2, 12, false), "N-缺少话题", "Y"],
    ] as const;
    for (const [resultId, selfReview, interaction] of exportCases) {
      const response = await page.request.get(`/api/results/export?ids=${resultId}`);
      expect(response.ok()).toBeTruthy();
      const exported = new ExcelJS.Workbook();
      await exported.xlsx.load((await response.body()) as unknown as ExcelJS.Buffer);
      expect(exported.worksheets[0].name).toBe(WYETH_NESTLE_SHEET_NAME);
      expect(exported.worksheets[0].getCell("K2").text).toContain(selfReview);
      expect(exported.worksheets[0].getCell("L2").text).toBe(interaction);
    }

    shared.addRow([
      "登记人5", "微信昵称5", "京东", wyethStore.storeName, "爱他美澳洲白金版",
      `ORDER-${suffix}-unsupported`, "小红书", `${E2E_ORIGIN}/mock/xhs?case=passed&unsupported=${suffix}`,
      "2026-09-12 10:00:00", "", "", "",
    ]);
    const invalidResponse = await page.request.post("/api/import/notes", {
      multipart: {
        file: {
          name: "VERIDIA审核导入模板.xlsx",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
        },
        commit: "false",
      },
    });
    const invalidPayload = (await invalidResponse.json()).data as {
      rows: Array<{ errors: string[] }>;
    };
    expect(invalidPayload.rows.at(-1)!.errors).toContain(
      `${WYETH_NESTLE_SHEET_NAME} 第 6 行：该产品不属于惠氏/雀巢导入模板支持范围`,
    );

    const duplicateWorkbook = new ExcelJS.Workbook();
    const duplicateTemplate = await page.request.get("/api/import/template?format=xlsx");
    await duplicateWorkbook.xlsx.load((await duplicateTemplate.body()) as unknown as ExcelJS.Buffer);
    duplicateWorkbook.getWorksheet("达能客户导入")!.addRow([
      "京东", "京东健康官方进口超市", "客户", "不存在产品", "2段", "IFFO",
      "DUP-DANONE", "小红书", urls[0], "2026-09-12 10:00:00", "不存在活动",
    ]);
    duplicateWorkbook.getWorksheet(WYETH_NESTLE_SHEET_NAME)!.addRow([
      "登记人", "微信", "京东", wyethStore.storeName, products[0].name, "DUP-WYETH",
      "小红书", urls[0], "2026-09-12 10:00:00", "", "", "",
    ]);
    const duplicateResponse = await page.request.post("/api/import/notes", {
      multipart: {
        file: {
          name: "跨Sheet重复.xlsx",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          buffer: Buffer.from(await duplicateWorkbook.xlsx.writeBuffer()),
        },
        commit: "false",
      },
    });
    const duplicatePayload = (await duplicateResponse.json()).data as {
      duplicateWarningCount: number;
      rows: Array<{ sheetName: string; duplicateWarning?: { kind: string; batchDuplicateOfSheet?: string } }>;
    };
    expect(duplicatePayload.duplicateWarningCount).toBe(1);
    expect(duplicatePayload.rows.find((row) => row.sheetName === WYETH_NESTLE_SHEET_NAME)?.duplicateWarning)
      .toMatchObject({ kind: "CURRENT_FILE", batchDuplicateOfSheet: "达能客户导入" });
  } finally {
    const results = createdTaskIds.length
      ? await prisma.auditResult.findMany({
          where: { auditTaskId: { in: createdTaskIds } },
          select: { id: true, noteId: true },
        })
      : [];
    const resultIds = results.map((result) => result.id);
    const noteIds = results.map((result) => result.noteId);
    const batches = createdTaskIds.length
      ? await prisma.auditTask.findMany({
          where: { id: { in: createdTaskIds } },
          select: { batchId: true },
        })
      : [];
    if (resultIds.length) {
      await prisma.manualReview.deleteMany({ where: { auditResultId: { in: resultIds } } });
      await prisma.ruleResult.deleteMany({ where: { auditResultId: { in: resultIds } } });
      await prisma.auditResult.deleteMany({ where: { id: { in: resultIds } } });
    }
    if (createdTaskIds.length) {
      await prisma.extractionRecord.deleteMany({ where: { auditTaskId: { in: createdTaskIds } } });
      await prisma.auditTask.deleteMany({ where: { id: { in: createdTaskIds } } });
    }
    if (noteIds.length) {
      await prisma.noteProduct.deleteMany({ where: { noteId: { in: noteIds } } });
      await prisma.noteRecord.deleteMany({
        where: {
          id: { in: noteIds },
          auditResults: { none: {} },
          extractions: { none: {} },
          noteProducts: { none: {} },
        },
      });
    }
    const batchIds = [...new Set(batches.map((batch) => batch.batchId).filter((id): id is string => Boolean(id)))];
    if (batchIds.length) await prisma.auditBatch.deleteMany({ where: { id: { in: batchIds } } });
    await prisma.topicRule.deleteMany({ where: { productId: { in: products.map((product) => product.id) } } });
    await prisma.campaign.deleteMany({ where: { id: { in: campaigns.map((campaign) => campaign.id) } } });
    await prisma.product.deleteMany({ where: { id: { in: products.map((product) => product.id) } } });
  }
});

test("统一 Workbook 八行审核后按 ImportRecord 导出单一三 Sheet 结果文件", async ({ page }) => {
  test.setTimeout(240_000);
  await ensureStoreTopicRuleSeeds();
  expect((await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  })).ok()).toBeTruthy();

  const suffix = Date.now().toString(36);
  const sharedProducts = await Promise.all(
    (["惠氏", "惠氏", "雀巢", "雀巢"] as const).map((brandName, index) =>
      prisma.product.create({
        data: {
          id: `e2e-mixed-product-${suffix}-${index}`,
          code: `E2E-MIXED-${suffix}-${index}`,
          name: `E2E混合${brandName}产品${index + 1}-${suffix}`,
          brandName,
        },
      }),
    ),
  );
  const sharedCampaigns = await Promise.all(sharedProducts.map((product, index) =>
    prisma.campaign.create({
      data: {
        id: `e2e-mixed-campaign-${suffix}-${index}`,
        name: `E2E混合导出活动${index + 1}-${suffix}`,
        month: "2026-09",
        startDate: new Date("2026-09-01T00:00:00.000Z"),
        endDate: new Date("2026-09-30T23:59:59.999Z"),
        contentChannel: "XIAOHONGSHU",
        productId: product.id,
      },
    }),
  ));
  await prisma.topicRule.createMany({
    data: sharedProducts.map((product, index) => ({
      id: `e2e-mixed-rule-${suffix}-${index}`,
      campaignId: sharedCampaigns[index].id,
      productId: product.id,
      brandName: product.brandName,
      contentChannel: "XIAOHONGSHU",
      scope: "CAMPAIGN",
      ruleType: "REQUIRED",
      topic: `#E2E混合导出${index + 1}`,
    })),
  });
  let importRecordId: string | null = null;

  try {
    const products = (await (await page.request.get("/api/products")).json()).data as Array<{
      id: string;
      name: string;
      brandName: string;
    }>;
    const danoneProduct = products.find((product) =>
      product.brandName === "达能" && product.name.includes("澳洲白金版"),
    )!;
    expect(danoneProduct).toBeTruthy();
    const danoneCampaigns = (await (
      await page.request.get(`/api/campaigns?productId=${danoneProduct.id}&contentChannel=XIAOHONGSHU`)
    ).json()).data as Array<{ name: string; month: string; contentChannel: string }>;
    const danoneCampaign = danoneCampaigns.find((campaign) =>
      campaign.month === "2026-08" && campaign.contentChannel === "XIAOHONGSHU",
    )!;
    expect(danoneCampaign).toBeTruthy();
    const [wyethStore, nestleStore] = await Promise.all([
      prisma.storeTopicRule.findFirstOrThrow({
        where: { commercePlatform: "JD", enabled: true, deletedAt: null, storeName: { contains: "惠氏" } },
      }),
      prisma.storeTopicRule.findFirstOrThrow({
        where: { commercePlatform: "JD", enabled: true, deletedAt: null, storeName: { contains: "雀巢" } },
      }),
    ]);

    const templateResponse = await page.request.get("/api/import/template?format=xlsx");
    expect(templateResponse.ok()).toBeTruthy();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await templateResponse.body()) as unknown as ExcelJS.Buffer);
    const danone = workbook.getWorksheet("达能客户导入")!;
    for (let index = 0; index < 2; index += 1) {
      danone.addRow([
        "京东", "京东健康官方进口超市", `混合达能${index + 1}`, danoneProduct.name,
        "2段", "IFFO", `MIX-D-${suffix}-${index}`, "小红书",
        `${E2E_ORIGIN}/mock/xhs?case=passed&mixed-danone=${suffix}-${index}`,
        "2026-08-12 10:00:00", danoneCampaign.name,
      ]);
    }
    const kabrita = workbook.getWorksheet("佳贝艾特客户导入")!;
    ["荷兰佳贝1", "荷兰佳贝2"].forEach((productLine, index) => kabrita.addRow([
      "2026-09-12", "京东", "佳贝艾特(Kabrita)海外专卖店", `混合佳贝${index + 1}`,
      `BUYER-${suffix}-${index}`, `MIX-K-${suffix}-${index}`, "2026-08-12", "1", "1",
      `kabrita-${index + 1}`, `${E2E_ORIGIN}/mock/xhs?case=passed&mixed-kabrita=${suffix}-${index}`,
      productLine, "Y",
    ]));
    const shared = workbook.getWorksheet(WYETH_NESTLE_SHEET_NAME)!;
    sharedProducts.forEach((product, index) => shared.addRow([
      `登记人${index + 1}`, `混合微信${index + 1}`, "京东",
      product.brandName === "惠氏" ? wyethStore.storeName : nestleStore.storeName,
      product.name, `MIX-WN-${suffix}-${index}`, "小红书",
      `${E2E_ORIGIN}/mock/xhs?case=passed&mixed-wn=${suffix}-${index}`,
      "2026-09-12 10:00:00", "", "Y", "Y",
    ]));

    const importResponse = await page.request.post("/api/import/notes", {
      multipart: {
        file: {
          name: `VERIDIA混合审核-${suffix}.xlsx`,
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
        },
        commit: "true",
        skipDuplicates: "true",
      },
    });
    const imported = await importResponse.json();
    expect(importResponse.ok(), JSON.stringify(imported)).toBeTruthy();
    expect(imported.data).toMatchObject({
      total: 8,
      validCount: 8,
      invalidCount: 0,
      importedCount: 8,
    });
    importRecordId = imported.data.importRecordId;
    expect(importRecordId).toBeTruthy();
    expect((await prisma.importRecord.findUniqueOrThrow({ where: { id: importRecordId! } })).totalCount)
      .toBe(8);
    await expect.poll(
      () => prisma.auditResult.count({ where: { task: { importRecordId } } }),
      { timeout: 180_000 },
    ).toBe(8);
    await expect.poll(async () => {
      const batches = await prisma.auditBatch.findMany({
        where: { id: { in: imported.data.batchIds } },
        select: { status: true },
      });
      return batches.every((batch) => ["COMPLETED", "COMPLETED_WITH_ERRORS"].includes(batch.status));
    }, { timeout: 30_000 }).toBe(true);

    const results = await prisma.auditResult.findMany({
      where: { task: { importRecordId } },
      include: { task: { select: { id: true, orderNumber: true } } },
    });
    for (const result of results) {
      const order = result.task.orderNumber || "";
      const kabritaIndex = order.includes("MIX-K-") ? Number(order.endsWith("-1")) : -1;
      const wyethNestleIndex = order.includes("MIX-WN-")
        ? Number(order.slice(order.lastIndexOf("-") + 1))
        : -1;
      const total = kabritaIndex === 0
        ? 10
        : kabritaIndex === 1
          ? 9
          : wyethNestleIndex === 0
            ? 9
            : wyethNestleIndex === 2
              ? 10
              : 12;
      const kabritaLow = kabritaIndex === 1;
      await prisma.auditResult.update({
        where: { id: result.id },
        data: {
          autoStatus: kabritaLow ? "FAILED" : "PASSED",
          failureReasons: kabritaLow
            ? JSON.stringify(["基础奖励未达成：互动合计 9"])
            : "[]",
          likeCount: Math.max(total - 5, 0),
          commentCount: Math.min(total, 3),
          favoriteCount: Math.min(Math.max(total - 3, 0), 2),
          interactionTotal: total,
        },
      });
      await prisma.auditTask.update({
        where: { id: result.task.id },
        data: { status: "SUCCEEDED", failureCode: null, failureMessage: null },
      });
    }

    const exportResponse = await page.request.get(
      `/api/results/export?format=xlsx&importRecordId=${importRecordId}`,
    );
    expect(exportResponse.ok()).toBeTruthy();
    expect(exportResponse.headers()["x-veridia-export-count"]).toBe("8");
    expect(exportResponse.headers()["x-veridia-export-workbook"]).toBe("UNIFIED");
    const exported = new ExcelJS.Workbook();
    await exported.xlsx.load((await exportResponse.body()) as unknown as ExcelJS.Buffer);
    expect(exported.worksheets.map((sheet) => sheet.name)).toEqual([
      "达能客户导入",
      "佳贝艾特客户导入",
      WYETH_NESTLE_SHEET_NAME,
    ]);
    expect(exported.worksheets.map((sheet) => sheet.rowCount)).toEqual([3, 3, 5]);
    const exportedOrders = (sheetName: string, header: string) => {
      const sheet = exported.getWorksheet(sheetName)!;
      const column = (sheet.getRow(1).values as unknown[]).indexOf(header);
      return Array.from({ length: sheet.rowCount - 1 }, (_, index) =>
        sheet.getCell(index + 2, column).text,
      );
    };
    expect(exportedOrders("达能客户导入", "订单编号").every((order) => order.includes("MIX-D-")))
      .toBe(true);
    expect(exportedOrders("佳贝艾特客户导入", "购买订单号").every((order) => order.includes("MIX-K-")))
      .toBe(true);
    expect(exportedOrders(WYETH_NESTLE_SHEET_NAME, "订单编号（必填）").every((order) => order.includes("MIX-WN-")))
      .toBe(true);
    expect(exported.getWorksheet("佳贝艾特客户导入")!.getCell("M2").text).toBe("Y");
    expect(exported.getWorksheet("佳贝艾特客户导入")!.getCell("M3").text).toBe("N-互动量＜10");
    expect(exported.getWorksheet(WYETH_NESTLE_SHEET_NAME)!.getCell("K2").text).toBe("Y");
    expect(exported.getWorksheet(WYETH_NESTLE_SHEET_NAME)!.getCell("L2").text).toBe("N");
    expect(exported.getWorksheet(WYETH_NESTLE_SHEET_NAME)!.getCell("K4").text).toBe("Y");
    expect(exported.getWorksheet(WYETH_NESTLE_SHEET_NAME)!.getCell("L4").text).toBe("Y");

    const mismatchedTask = await prisma.auditTask.findFirstOrThrow({
      where: { importRecordId, orderNumber: { contains: "MIX-WN-" } },
      select: { id: true, notes: true },
    });
    const mismatchedNotes = (mismatchedTask.notes || "").replace(
      '"templateType":"WYETH_NESTLE"',
      '"templateType":"KABRITA"',
    );
    expect(mismatchedNotes).not.toBe(mismatchedTask.notes);
    await prisma.auditTask.update({
      where: { id: mismatchedTask.id },
      data: { notes: mismatchedNotes },
    });
    const blockedExport = await page.request.get(
      `/api/results/export?format=xlsx&importRecordId=${importRecordId}`,
    );
    expect(blockedExport.status()).toBe(409);
    expect(await blockedExport.json()).toMatchObject({
      success: false,
      errorDetail: { code: "RESULT_SHEET_CLASSIFICATION_FAILED" },
    });
    await prisma.auditTask.update({
      where: { id: mismatchedTask.id },
      data: { notes: mismatchedTask.notes },
    });
  } finally {
    if (importRecordId) {
      const tasks = await prisma.auditTask.findMany({
        where: { importRecordId },
        select: { id: true, batchId: true },
      });
      const taskIds = tasks.map((task) => task.id);
      const results = await prisma.auditResult.findMany({
        where: { auditTaskId: { in: taskIds } },
        select: { id: true, noteId: true },
      });
      const resultIds = results.map((result) => result.id);
      const noteIds = results.map((result) => result.noteId);
      await prisma.manualReview.deleteMany({ where: { auditResultId: { in: resultIds } } });
      await prisma.ruleResult.deleteMany({ where: { auditResultId: { in: resultIds } } });
      await prisma.auditResult.deleteMany({ where: { id: { in: resultIds } } });
      await prisma.extractionRecord.deleteMany({ where: { auditTaskId: { in: taskIds } } });
      await prisma.auditTask.deleteMany({ where: { id: { in: taskIds } } });
      await prisma.auditBatch.deleteMany({
        where: { id: { in: tasks.map((task) => task.batchId).filter((id): id is string => Boolean(id)) } },
      });
      await prisma.importRecord.deleteMany({ where: { id: importRecordId } });
      await prisma.noteProduct.deleteMany({ where: { noteId: { in: noteIds } } });
      await prisma.noteRecord.deleteMany({
        where: { id: { in: noteIds }, auditResults: { none: {} }, extractions: { none: {} }, noteProducts: { none: {} } },
      });
    }
    await prisma.topicRule.deleteMany({ where: { productId: { in: sharedProducts.map((product) => product.id) } } });
    await prisma.campaign.deleteMany({ where: { id: { in: sharedCampaigns.map((campaign) => campaign.id) } } });
    await prisma.product.deleteMany({ where: { id: { in: sharedProducts.map((product) => product.id) } } });
  }
});
