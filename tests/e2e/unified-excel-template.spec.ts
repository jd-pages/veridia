import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";
import { prisma } from "../../lib/db";
import { E2E_ORIGIN } from "./e2e-origin";
import { ensureStoreTopicRuleSeeds } from "../../lib/store-topic-rule-service";
import { resolveProductReference } from "../../lib/product-matching";
import { buildImportedTaskNotes } from "../../lib/import-task-metadata";
import {
  NESTLE_SHEET_NAME,
  WYETH_NESTLE_LEGACY_SHEET_NAME,
  WYETH_NESTLE_SHEET_NAME,
  WYETH_SHEET_NAME,
} from "../../lib/import-template-type";

test.describe.configure({ mode: "serial" });

const AUDIT_RESULT_SHEET_NAMES = [
  "达能审核结果",
  "佳贝艾特审核结果",
  "惠氏审核结果",
  "雀巢审核结果",
] as const;

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
  const douyinCampaign = await prisma.campaign.create({
    data: {
      id: `e2e-unified-campaign-${suffix}-douyin`,
      name: `E2E统一模板抖音活动-${suffix}`,
      month: "2026-09",
      startDate: new Date("2026-09-01T00:00:00.000Z"),
      endDate: new Date("2026-09-30T23:59:59.999Z"),
      contentChannel: "DOUYIN",
      productId: products[0].id,
    },
  });
  campaigns.push(douyinCampaign);
  await prisma.topicRule.createMany({
    data: [
      ...products.map((product, index) => ({
      id: `e2e-unified-rule-${suffix}-${index}`,
      campaignId: campaigns[index].id,
      productId: product.id,
      brandName: product.brandName,
      contentChannel: "XIAOHONGSHU",
      scope: "CAMPAIGN",
      ruleType: "REQUIRED",
      topic: `#E2E统一模板${index + 1}`,
      })),
      {
        id: `e2e-unified-rule-${suffix}-douyin`,
        campaignId: douyinCampaign.id,
        productId: products[0].id,
        brandName: products[0].brandName,
        contentChannel: "DOUYIN",
        scope: "CAMPAIGN",
        ruleType: "REQUIRED",
        topic: "#E2E统一模板抖音",
      },
    ],
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
      .toEqual(["达能客户导入", "佳贝艾特客户导入", WYETH_SHEET_NAME, NESTLE_SHEET_NAME]);
    const productOptions = workbook.getWorksheet("产品列表")!;
    expect(productOptions.state).toBe("veryHidden");
    expect(productOptions.getColumn(1).values.join("|")).toContain(products[0].name);
    expect(productOptions.getColumn(2).values.join("|")).toContain(products[2].name);

    const wyethSheet = workbook.getWorksheet(WYETH_SHEET_NAME)!;
    const nestleSheet = workbook.getWorksheet(NESTLE_SHEET_NAME)!;
    const urls = products.map((_, index) => index === 1
      ? `${E2E_ORIGIN}/mock/douyin?case=passed&unified=${suffix}-${index}`
      : `${E2E_ORIGIN}/mock/xhs?case=passed&unified=${suffix}-${index}`,
    );
    const previewProducts = [products[0], products[0], products[2], products[2]];
    const previewCampaigns = [campaigns[0], douyinCampaign, campaigns[2], campaigns[2]];
    previewProducts.forEach((product, index) => (product.brandName === "惠氏" ? wyethSheet : nestleSheet).addRow([
      `登记人${index + 1}`,
      `微信昵称${index + 1}`,
      "京东",
      product.brandName === "惠氏" ? wyethStore.storeName : nestleStore.storeName,
      product.name,
      `ORDER-${suffix}-${index}`,
      index === 1 ? "抖音" : "小红书",
      urls[index],
      "2026-09-12 10:00:00",
      index === 0 || index === 2 ? "9月" : "",
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
        storeMappingStatus: string;
        expectedStoreTopics: string[];
        contentChannel: string;
        errors: string[];
      }>;
    };
    expect(preview).toMatchObject({ total: 4, validCount: 4, invalidCount: 0 });
    expect(preview.rows.map((row) => row.productId)).toEqual(previewProducts.map((product) => product.id));
    expect(preview.rows.map((row) => row.campaignId)).toEqual(previewCampaigns.map((campaign) => campaign.id));
    expect(preview.rows.map((row) => row.sheetName)).toEqual([
      WYETH_SHEET_NAME,
      WYETH_SHEET_NAME,
      NESTLE_SHEET_NAME,
      NESTLE_SHEET_NAME,
    ]);
    expect(preview.rows.map((row) => row.contentChannel)).toEqual([
      "小红书", "抖音", "小红书", "小红书",
    ]);
    expect(preview.rows.every((row) => row.matchedStoreName)).toBe(true);
    expect(preview.rows.every((row) => row.storeMappingStatus === "NOT_APPLICABLE"))
      .toBe(true);
    expect(preview.rows.every((row) => row.expectedStoreTopics.length === 0))
      .toBe(true);
    expect(preview.rows.flatMap((row) => row.errors).join("；"))
      .not.toMatch(/店铺话题|STORE_NOT_MAPPED|未命中任何可接受店铺话题/u);

    const uploadPreview = async (candidate: ExcelJS.Workbook, name: string) => {
      const response = await page.request.post("/api/import/notes", {
        multipart: {
          file: {
            name,
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            buffer: Buffer.from(await candidate.xlsx.writeBuffer()),
          },
          commit: "false",
          skipDuplicates: "true",
        },
      });
      const payload = await response.json();
      expect(response.ok(), JSON.stringify(payload)).toBeTruthy();
      return payload.data as {
        validCount: number;
        invalidCount: number;
        rows: Array<{
          sheetName: string;
          campaignId?: string;
          importedCampaignName: string;
          campaignMatchStatus: string;
          errors: string[];
        }>;
      };
    };

    const monthlyWorkbook = async (
      month: string,
      product = products[0],
      publishTime = "2026-09-12 10:00:00",
    ) => {
      const candidate = new ExcelJS.Workbook();
      await candidate.xlsx.load((await (await page.request.get("/api/import/template?format=xlsx")).body()) as unknown as ExcelJS.Buffer);
      candidate.getWorksheet(product.brandName === "惠氏" ? WYETH_SHEET_NAME : NESTLE_SHEET_NAME)!.addRow([
        "登记人", "微信", "京东",
        product.brandName === "惠氏" ? wyethStore.storeName : nestleStore.storeName,
        product.name, `MONTH-${suffix}-${month}-${product.id}`, "小红书",
        `${E2E_ORIGIN}/mock/xhs?case=passed&month=${suffix}-${month}-${product.id}`,
        publishTime, month, "", "", "",
      ]);
      return candidate;
    };

    const notFoundPreview = await uploadPreview(
      await monthlyWorkbook("10月"),
      "activity-not-found.xlsx",
    );
    expect(notFoundPreview.rows[0].campaignMatchStatus).toBe("ACTIVITY_NOT_FOUND");

    const duplicateCampaign = await prisma.campaign.create({
      data: {
        id: `e2e-unified-campaign-${suffix}-duplicate`,
        name: `E2E统一模板同年重复-${suffix}`,
        month: "2026-09",
        startDate: new Date("2026-09-01T00:00:00.000Z"),
        endDate: new Date("2026-09-30T23:59:59.999Z"),
        contentChannel: "XIAOHONGSHU",
        productId: products[0].id,
      },
    });
    campaigns.push(duplicateCampaign);
    await prisma.topicRule.create({
      data: {
        id: `e2e-unified-rule-${suffix}-duplicate`, campaignId: duplicateCampaign.id,
        productId: products[0].id, brandName: "惠氏", contentChannel: "XIAOHONGSHU",
        scope: "CAMPAIGN", ruleType: "REQUIRED", topic: "#E2E同年重复",
      },
    });
    const ambiguousPreview = await uploadPreview(
      await monthlyWorkbook("9月"),
      "activity-ambiguous.xlsx",
    );
    expect(ambiguousPreview.rows[0].campaignMatchStatus).toBe("ACTIVITY_AMBIGUOUS");
    await prisma.topicRule.deleteMany({ where: { campaignId: duplicateCampaign.id } });
    await prisma.campaign.delete({ where: { id: duplicateCampaign.id } });

    const nextYearCampaign = await prisma.campaign.create({
      data: {
        id: `e2e-unified-campaign-${suffix}-2027`,
        name: `E2E统一模板跨年-${suffix}`,
        month: "2027-09",
        year: 2027,
        startDate: new Date("2027-09-01T00:00:00.000Z"),
        endDate: new Date("2027-09-30T23:59:59.999Z"),
        contentChannel: "XIAOHONGSHU",
        productId: products[0].id,
      },
    });
    campaigns.push(nextYearCampaign);
    await prisma.topicRule.create({
      data: {
        id: `e2e-unified-rule-${suffix}-2027`, campaignId: nextYearCampaign.id,
        productId: products[0].id, brandName: "惠氏", contentChannel: "XIAOHONGSHU",
        scope: "CAMPAIGN", ruleType: "REQUIRED", topic: "#E2E跨年",
      },
    });
    const yearAmbiguousPreview = await uploadPreview(
      await monthlyWorkbook("9月"),
      "activity-year-ambiguous.xlsx",
    );
    expect(yearAmbiguousPreview.rows[0].campaignMatchStatus).toBe("ACTIVITY_YEAR_AMBIGUOUS");
    const explicitYearPreview = await uploadPreview(
      await monthlyWorkbook("2027-09", products[0], "2027-09-12 10:00:00"),
      "activity-explicit-year.xlsx",
    );
    expect(explicitYearPreview.rows[0]).toMatchObject({
      campaignMatchStatus: "MATCHED",
      campaignId: nextYearCampaign.id,
    });
    await prisma.topicRule.deleteMany({ where: { campaignId: nextYearCampaign.id } });
    await prisma.campaign.delete({ where: { id: nextYearCampaign.id } });

    const conflictWorkbook = await monthlyWorkbook("8月");
    conflictWorkbook.getWorksheet(WYETH_SHEET_NAME)!.addRow([
      "登记人2", "微信2", "京东", wyethStore.storeName, products[0].name,
      `MONTH-CONFLICT-${suffix}`, "小红书",
      `${E2E_ORIGIN}/mock/xhs?case=passed&month-conflict=${suffix}`,
      "2026-09-12 10:00:00", "9月", "", "", "",
    ]);
    const conflictPreview = await uploadPreview(conflictWorkbook, "activity-month-conflict.xlsx");
    expect(conflictPreview.rows.every((row) => row.errors.join("\n").includes("SHEET_ACTIVITY_MONTH_CONFLICT")))
      .toBe(true);

    const aliasWorkbook = new ExcelJS.Workbook();
    await aliasWorkbook.xlsx.load((await (await page.request.get("/api/import/template?format=xlsx")).body()) as unknown as ExcelJS.Buffer);
    const aliasSheet = aliasWorkbook.getWorksheet(WYETH_SHEET_NAME)!;
    aliasSheet.name = WYETH_NESTLE_LEGACY_SHEET_NAME;
    aliasWorkbook.removeWorksheet(aliasWorkbook.getWorksheet(NESTLE_SHEET_NAME)!.id);
    aliasSheet.addRow([
      "登记人", "微信", "京东", wyethStore.storeName, products[0].name, `ALIAS-${suffix}`,
      "小红书", `${E2E_ORIGIN}/mock/xhs?case=passed&alias=${suffix}`,
      "2026-09-12 10:00:00", "9月", "", "", "",
    ]);
    const aliasPreview = await uploadPreview(aliasWorkbook, "legacy-alias.xlsx");
    expect(aliasPreview).toMatchObject({ validCount: 1, invalidCount: 0 });
    expect(aliasPreview.rows[0].sheetName).toBe(WYETH_NESTLE_LEGACY_SHEET_NAME);

    const firstBlankWorkbook = new ExcelJS.Workbook();
    await firstBlankWorkbook.xlsx.load((await (await page.request.get("/api/import/template?format=xlsx")).body()) as unknown as ExcelJS.Buffer);
    firstBlankWorkbook.getWorksheet(WYETH_SHEET_NAME)!.addRow([
      "登记人", "微信", "京东", wyethStore.storeName, products[0].name, `BLANK-${suffix}`,
      "小红书", `${E2E_ORIGIN}/mock/xhs?case=passed&blank=${suffix}`,
      "2026-09-12 10:00:00", "", "", "", "",
    ]);
    const firstBlankPreview = await uploadPreview(firstBlankWorkbook, "first-blank.xlsx");
    expect(firstBlankPreview.invalidCount).toBe(1);
    expect(firstBlankPreview.rows[0].errors.join("\n"))
      .toContain("当前工作表存在业务数据，但未填写活动月份。");

    const mismatchWorkbook = new ExcelJS.Workbook();
    await mismatchWorkbook.xlsx.load((await (await page.request.get("/api/import/template?format=xlsx")).body()) as unknown as ExcelJS.Buffer);
    const mismatchSheet = mismatchWorkbook.getWorksheet(WYETH_SHEET_NAME)!;
    mismatchSheet.addRow([
      "登记人1", "微信1", "京东", wyethStore.storeName, products[0].name, `MATCH-${suffix}`,
      "小红书", `${E2E_ORIGIN}/mock/xhs?case=passed&match=${suffix}`,
      "2026-09-12 10:00:00", "9月", "", "", "",
    ]);
    mismatchSheet.addRow([
      "登记人2", "微信2", "京东", nestleStore.storeName, products[2].name, `MISMATCH-${suffix}`,
      "小红书", `${E2E_ORIGIN}/mock/xhs?case=passed&mismatch=${suffix}`,
      "2026-09-12 10:00:00", "", "", "", "",
    ]);
    const mismatchPreview = await uploadPreview(mismatchWorkbook, "brand-mismatch.xlsx");
    expect(mismatchPreview).toMatchObject({ validCount: 1, invalidCount: 1 });
    expect(mismatchPreview.rows[1].errors.join("\n"))
      .toContain("PRODUCT_BRAND_SHEET_MISMATCH");

    const legacyWorkbook = new ExcelJS.Workbook();
    const legacySheet = legacyWorkbook.addWorksheet(WYETH_NESTLE_SHEET_NAME);
    legacySheet.addRow([
      "登记人（必填）", "微信昵称（必填）", "下单平台（必填）", "店铺名称（必填）",
      "产品系列（必填）", "订单编号（必填）", "内容渠道（必填）", "链接（必填）纯链接",
      "发帖时间（必填）", "客服修改留言", "内部自审", "互动量≥10",
    ]);
    legacySheet.addRow([
      "登记人", "微信", "京东", wyethStore.storeName, products[0].name, `LEGACY-${suffix}`,
      "小红书", `${E2E_ORIGIN}/mock/xhs?case=passed&legacy=${suffix}`,
      "2026-09-12 10:00:00", "", "", "",
    ]);
    const legacyPreview = await uploadPreview(legacyWorkbook, "legacy-no-activity.xlsx");
    expect(legacyPreview).toMatchObject({ validCount: 1, invalidCount: 0 });
    expect(legacyPreview.rows[0].campaignId).toBe(campaigns[0].id);

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
      [await audit(0, 9, true), "惠氏审核结果", "Y", "N"],
      [await audit(1, 10, true), "惠氏审核结果", "Y", "Y"],
      [await audit(2, 12, false), "雀巢审核结果", "N-缺少话题", "Y"],
    ] as const;
    for (const [resultId, sheetName, selfReview, interaction] of exportCases) {
      const response = await page.request.get(`/api/results/export?ids=${resultId}`);
      expect(response.ok()).toBeTruthy();
      const exported = new ExcelJS.Workbook();
      await exported.xlsx.load((await response.body()) as unknown as ExcelJS.Buffer);
      expect(exported.worksheets.map((sheet) => sheet.name)).toEqual(AUDIT_RESULT_SHEET_NAMES);
      const sheet = exported.getWorksheet(sheetName)!;
      const headers = (sheet.getRow(1).values as unknown[]).slice(1);
      expect(sheet.getCell(2, headers.indexOf("内部自审") + 1).text).toContain(selfReview);
      expect(sheet.getCell(2, headers.indexOf("互动量≥10") + 1).text).toBe(interaction);
      expect(headers.at(-1)).toBe("活动月份");
    }

    wyethSheet.addRow([
      "登记人5", "微信昵称5", "京东", wyethStore.storeName, "爱他美澳洲白金版",
      `ORDER-${suffix}-unsupported`, "小红书", `${E2E_ORIGIN}/mock/xhs?case=passed&unsupported=${suffix}`,
      "2026-09-12 10:00:00", "", "", "", "",
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
    expect(invalidPayload.rows.some((row) =>
      row.errors.join("\n").includes("PRODUCT_BRAND_SHEET_MISMATCH"),
    )).toBe(true);

    const duplicateWorkbook = new ExcelJS.Workbook();
    const duplicateTemplate = await page.request.get("/api/import/template?format=xlsx");
    await duplicateWorkbook.xlsx.load((await duplicateTemplate.body()) as unknown as ExcelJS.Buffer);
    duplicateWorkbook.getWorksheet("达能客户导入")!.addRow([
      "京东", "京东健康官方进口超市", "客户", "不存在产品", "2段", "IFFO",
      "DUP-DANONE", "小红书", urls[0], "2026-09-12 10:00:00", "9月",
    ]);
    duplicateWorkbook.getWorksheet(WYETH_SHEET_NAME)!.addRow([
      "登记人", "微信", "京东", wyethStore.storeName, products[0].name, "DUP-WYETH",
      "小红书", urls[0], "2026-09-12 10:00:00", "9月", "", "", "",
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
    expect(duplicatePayload.rows.find((row) => row.sheetName === WYETH_SHEET_NAME)?.duplicateWarning)
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

test("统一 Workbook 八行审核加一行未审核后按 ImportRecord 导出单一四 Sheet 结果文件", async ({ page }) => {
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
    const kabritaProducts = await prisma.product.findMany({
      where: { brandName: "佳贝艾特", status: "ACTIVE", deletedAt: null },
      include: { aliases: { select: { alias: true } } },
    });
    const kabritaProductResolution = resolveProductReference(kabritaProducts, {
      name: "荷兰佳贝1",
    });
    expect(kabritaProductResolution.status).toBe("MATCHED");
    const kabritaProductId = kabritaProductResolution.status === "MATCHED"
      ? kabritaProductResolution.product.id
      : "";
    const kabritaCampaign = await prisma.campaign.findFirstOrThrow({
      where: {
        status: "ACTIVE",
        deletedAt: null,
        contentChannel: "XIAOHONGSHU",
        startDate: { lte: new Date("2026-08-12T00:00:00.000Z") },
        endDate: { gte: new Date("2026-08-12T00:00:00.000Z") },
        OR: [
          { productId: kabritaProductId },
          { products: { some: { productId: kabritaProductId } } },
        ],
        topicRules: {
          some: { status: "ACTIVE", contentChannel: { in: ["XIAOHONGSHU", "ALL"] } },
        },
      },
    });
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
        "京东", "京东健康官方进口超市", `混合达能${index + 1}`, "澳白",
        index === 0 ? "2段" : "IFFO", index === 0 ? "IFFO" : "2段",
        `MIX-D-${suffix}-${index}`, "小红书",
        `${E2E_ORIGIN}/mock/xhs?case=passed&mixed-danone=${suffix}-${index}`,
        "2026-08-12 10:00:00", index === 0 ? "8月" : "",
      ]);
    }
    const kabrita = workbook.getWorksheet("佳贝艾特客户导入")!;
    ["荷兰佳贝1", "荷兰佳贝1"].forEach((productLine, index) => kabrita.addRow([
      "2026-09-12", "京东", "佳贝艾特(Kabrita)海外专卖店", `混合佳贝${index + 1}`,
      `BUYER-${suffix}-${index}`, `MIX-K-${suffix}-${index}`, "2026-08-12", "1", "1",
      `kabrita-${index + 1}`, `${E2E_ORIGIN}/mock/xhs?case=passed&mixed-kabrita=${suffix}-${index}`,
      productLine, index === 0 ? "8月" : "", "Y",
    ]));
    const sharedImportProducts = [sharedProducts[0], sharedProducts[0], sharedProducts[2], sharedProducts[2]];
    sharedImportProducts.forEach((product, index) => (product.brandName === "惠氏"
      ? workbook.getWorksheet(WYETH_SHEET_NAME)!
      : workbook.getWorksheet(NESTLE_SHEET_NAME)!).addRow([
      `登记人${index + 1}`, `混合微信${index + 1}`, "京东",
      product.brandName === "惠氏" ? wyethStore.storeName : nestleStore.storeName,
      product.name, `MIX-WN-${suffix}-${index}`, "小红书",
      `${E2E_ORIGIN}/mock/xhs?case=passed&mixed-wn=${suffix}-${index}`,
      "2026-09-12 10:00:00", index === 0 || index === 2 ? "9月" : "",
      "", "Y", "Y",
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
      include: {
        task: {
          select: {
            id: true,
            orderNumber: true,
            product: { select: { brandName: true } },
          },
        },
        ruleResults: true,
      },
    });
    const wyethNestleResults = results.filter((result) =>
      ["惠氏", "雀巢"].includes(result.task.product.brandName),
    );
    expect(wyethNestleResults).toHaveLength(4);
    for (const result of wyethNestleResults) {
      expect(result.storeTopicStatus).toBe("NOT_REQUIRED");
      expect(result.ruleResults.some((rule) => rule.ruleKey === "STORE_TOPIC"))
        .toBe(false);
    }
    const [storeOnly, storeAndBody, storeAndUnknown] = wyethNestleResults;
    const legacyStoreReason = "未命中任何可接受店铺话题：#FOLO海外专营店";
    await prisma.ruleResult.updateMany({
      where: {
        auditResultId: {
          in: [storeOnly.id, storeAndBody.id, storeAndUnknown.id],
        },
        ruleKey: { startsWith: "TOPIC_" },
      },
      data: {
        actualValue: "精确出现且为可点击话题",
        passed: true,
        failureReason: null,
        evidence: JSON.stringify({
          dom: { finalClickability: "CLICKABLE" },
        }),
      },
    });
    await prisma.ruleResult.createMany({
      data: [storeOnly, storeAndBody, storeAndUnknown].map((result) => ({
        auditResultId: result.id,
        ruleKey: "STORE_TOPIC",
        ruleName: "店铺话题审核",
        expectedValue: "#FOLO海外专营店",
        actualValue: "未命中",
        passed: false,
        failureReason: legacyStoreReason,
        evidence: JSON.stringify({ status: "NON_COMPLIANT" }),
      })),
    });
    await Promise.all([
      prisma.auditResult.update({
        where: { id: storeOnly.id },
        data: {
          autoStatus: "FAILED",
          pageStatus: "NORMAL",
          bodyStatus: "PRESENT",
          bodyCompliant: true,
          imageStatus: "COMPLIANT",
          imageCompliant: true,
          topicsCompliant: false,
          clickableCompliant: true,
          missingTopics: "[]",
          forbiddenTopics: "[]",
          publicStatus: "PUBLIC",
          storeTopicStatus: "NON_COMPLIANT",
          storeTopicFailureReason: legacyStoreReason,
          failureReasons: JSON.stringify([legacyStoreReason]),
        },
      }),
      prisma.auditResult.update({
        where: { id: storeAndBody.id },
        data: {
          autoStatus: "FAILED",
          pageStatus: "NORMAL",
          bodyStatus: "PRESENT",
          bodyCompliant: false,
          imageStatus: "COMPLIANT",
          imageCompliant: true,
          topicsCompliant: false,
          clickableCompliant: true,
          missingTopics: "[]",
          forbiddenTopics: "[]",
          publicStatus: "PUBLIC",
          storeTopicStatus: "NON_COMPLIANT",
          storeTopicFailureReason: legacyStoreReason,
          failureReasons: JSON.stringify([
            legacyStoreReason,
            "有效正文字数不足：要求至少 100 个，实际 20 个",
          ]),
        },
      }),
      prisma.auditResult.update({
        where: { id: storeAndUnknown.id },
        data: {
          autoStatus: "NEEDS_REVIEW",
          pageStatus: "NORMAL",
          bodyStatus: "PRESENT",
          bodyCompliant: true,
          imageStatus: "COMPLIANT",
          imageCompliant: true,
          topicsCompliant: false,
          clickableCompliant: true,
          missingTopics: "[]",
          forbiddenTopics: "[]",
          publicStatus: "UNKNOWN",
          storeTopicStatus: "NON_COMPLIANT",
          storeTopicFailureReason: legacyStoreReason,
          failureReasons: JSON.stringify([legacyStoreReason]),
        },
      }),
    ]);
    const legacyIds = [storeOnly.id, storeAndBody.id, storeAndUnknown.id];
    const legacyListResponse = await page.request.get(
      `/api/results?ids=${legacyIds.join(",")}&pageSize=10`,
    );
    const legacyList = (await legacyListResponse.json()).data.items as Array<{
      id: string;
      presentation: {
        automaticConclusion: { status: string };
        storeTopic: { status: string };
      };
    }>;
    expect(legacyListResponse.ok()).toBeTruthy();
    const presentedStatus = (id: string) =>
      legacyList.find((result) => result.id === id)!.presentation;
    expect(presentedStatus(storeOnly.id)).toMatchObject({
      automaticConclusion: { status: "PASSED" },
      storeTopic: { status: "NOT_APPLICABLE" },
    });
    expect(presentedStatus(storeAndBody.id).automaticConclusion.status)
      .toBe("FAILED");
    expect(presentedStatus(storeAndUnknown.id).automaticConclusion.status)
      .toBe("NEEDS_REVIEW");

    const legacyDetail = (await (
      await page.request.get(`/api/results/${storeOnly.id}`)
    ).json()).data;
    expect(legacyDetail.presentation).toMatchObject({
      automaticConclusion: { status: "PASSED" },
      storeTopic: { status: "NOT_APPLICABLE" },
    });
    const normalizedPassed = await page.request.get(
      `/api/results?ids=${storeOnly.id}&status=PASSED&pageSize=10`,
    );
    expect((await normalizedPassed.json()).data.total).toBe(1);

    const legacyExportResponse = await page.request.get(
      `/api/results/export?format=xlsx&ids=${storeOnly.id}`,
    );
    expect(legacyExportResponse.ok()).toBeTruthy();
    const legacyExport = new ExcelJS.Workbook();
    await legacyExport.xlsx.load(
      (await legacyExportResponse.body()) as unknown as ExcelJS.Buffer,
    );
    const legacySheet = legacyExport.getWorksheet(
      `${storeOnly.task.product.brandName}审核结果`,
    )!;
    const selfReviewColumn = (legacySheet.getRow(1).values as unknown[])
      .indexOf("内部自审");
    expect(selfReviewColumn).toBeGreaterThan(0);
    expect(legacySheet.getCell(2, selfReviewColumn).text).toBe("Y");

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
      const interactionUnknown = wyethNestleIndex === 3;
      const videoFixture = wyethNestleIndex === 0;
      await prisma.auditResult.update({
        where: { id: result.id },
        data: {
          autoStatus: kabritaLow ? "FAILED" : "PASSED",
          pageStatus: "NORMAL",
          bodyStatus: "PRESENT",
          bodyCompliant: true,
          noteType: videoFixture ? "VIDEO" : "IMAGE_TEXT",
          imageExtractionStatus: videoFixture ? "VIDEO_NOTE" : "SUCCESS",
          imageCount: videoFixture ? 0 : result.imageCount,
          imageStatus: videoFixture ? "NOT_REQUIRED" : "COMPLIANT",
          imageCompliant: true,
          topicsCompliant: true,
          clickableCompliant: true,
          publicStatus: "PUBLIC",
          retentionStatus: "SATISFIED",
          storeTopicStatus: "COMPLIANT",
          failureReasons: kabritaLow
            ? JSON.stringify(["基础奖励未达成：互动合计 9"])
            : "[]",
          likeCount: Math.max(total - 5, 0),
          commentCount: Math.min(total, 3),
          favoriteCount: interactionUnknown ? null : Math.min(Math.max(total - 3, 0), 2),
          interactionTotal: interactionUnknown ? null : total,
        },
      });
      // This fixture deliberately synthesizes the final interaction outcome
      // after the deterministic audit. Keep every persisted audit fact in the
      // same coherent state so the export is not testing an impossible
      // PASSED + failed RuleResult combination.
      await prisma.ruleResult.updateMany({
        where: { auditResultId: result.id },
        data: { passed: true, failureReason: null },
      });
      if (kabritaIndex >= 0) {
        await prisma.ruleResult.updateMany({
          where: {
            auditResultId: result.id,
            ruleKey: "KABRITA_BASIC_REWARD",
          },
          data: {
            passed: !kabritaLow,
            actualValue: `点赞 ${Math.max(total - 5, 0)} + 收藏 ${Math.min(Math.max(total - 3, 0), 2)} + 评论 ${Math.min(total, 3)} = ${total}`,
            failureReason: kabritaLow
              ? `基础奖励未达成：互动合计 ${total}`
              : null,
          },
        });
      }
      await prisma.auditTask.update({
        where: { id: result.task.id },
        data: { status: "SUCCEEDED", failureCode: null, failureMessage: null },
      });
    }

    const unreviewedOrderNumber = `MIX-WN-${suffix}-UNREVIEWED`;
    const unreviewedUrl = `${E2E_ORIGIN}/mock/xhs?case=passed&mixed-unreviewed=${suffix}`;
    await prisma.auditTask.create({
      data: {
        importRecordId,
        url: unreviewedUrl,
        originalInput: unreviewedUrl,
        normalizedUrl: unreviewedUrl,
        productId: sharedProducts[1].id,
        campaignId: sharedCampaigns[1].id,
        status: "PENDING",
        queueOrder: 99,
        platform: "XIAOHONGSHU",
        channel: "XIAOHONGSHU",
        commercePlatform: "JD",
        orderNumber: unreviewedOrderNumber,
        notes: buildImportedTaskNotes({
          platform: "京东",
          shopName: wyethStore.storeName,
          customerName: "未审核微信",
          orderNumber: unreviewedOrderNumber,
          contentChannel: "小红书",
          publishTime: "2026-09-12 10:00:00",
          templateMetadata: {
            templateType: "WYETH",
            templateBrand: "惠氏",
            rawValues: {
              registrant: "未审核登记人",
              wechatNickname: "未审核微信",
              commercePlatform: "京东",
              shopName: wyethStore.storeName,
              productName: sharedProducts[1].name,
              orderNumber: unreviewedOrderNumber,
              contentChannel: "小红书",
              noteUrl: unreviewedUrl,
              publishTime: "2026-09-12 10:00:00",
              activityMonth: "9月",
              customerServiceComment: "",
            },
          },
        }),
      },
    });
    await prisma.importRecord.update({
      where: { id: importRecordId! },
      data: { totalCount: 9 },
    });

    const exportResponse = await page.request.get(
      `/api/results/export?format=xlsx&importRecordId=${importRecordId}`,
    );
    expect(exportResponse.ok()).toBeTruthy();
    expect(exportResponse.headers()["x-veridia-export-count"]).toBe("9");
    expect(exportResponse.headers()["x-veridia-export-workbook"]).toBe("UNIFIED");
    const exported = new ExcelJS.Workbook();
    await exported.xlsx.load((await exportResponse.body()) as unknown as ExcelJS.Buffer);
    expect(exported.worksheets.map((sheet) => sheet.name))
      .toEqual(AUDIT_RESULT_SHEET_NAMES);
    expect(exported.worksheets.map((sheet) => sheet.rowCount)).toEqual([3, 3, 4, 3]);
    const exportedOrders = (sheetName: string, header: string) => {
      const sheet = exported.getWorksheet(sheetName)!;
      const column = (sheet.getRow(1).values as unknown[]).indexOf(header);
      return Array.from({ length: sheet.rowCount - 1 }, (_, index) =>
        sheet.getCell(index + 2, column).text,
      );
    };
    expect(exportedOrders("达能审核结果", "订单编号").every((order) => order.includes("MIX-D-")))
      .toBe(true);
    expect(exportedOrders("佳贝艾特审核结果", "购买订单号").every((order) => order.includes("MIX-K-")))
      .toBe(true);
    expect(exportedOrders("惠氏审核结果", "订单编号（必填）").every((order) => order.includes("MIX-WN-")))
      .toBe(true);
    expect(exportedOrders("雀巢审核结果", "订单编号（必填）").every((order) => order.includes("MIX-WN-")))
      .toBe(true);
    const headerCell = (sheetName: string, row: number, header: string) => {
      const sheet = exported.getWorksheet(sheetName)!;
      const headers = (sheet.getRow(1).values as unknown[]).slice(1);
      return sheet.getCell(row, headers.indexOf(header) + 1);
    };
    const kabritaExportMonth = `${Number(kabritaCampaign.month.slice(-2))}月`;
    expect(headerCell("佳贝艾特审核结果", 2, "活动月份").text).toBe(kabritaExportMonth);
    expect(headerCell("佳贝艾特审核结果", 3, "活动月份").text).toBe("");
    expect(headerCell("佳贝艾特审核结果", 2, "是否符合").text).toBe("Y");
    expect(headerCell("佳贝艾特审核结果", 3, "是否符合").text).toBe("N-互动量＜10");
    expect(headerCell("惠氏审核结果", 2, "活动月份").text).toBe("9月");
    expect(headerCell("惠氏审核结果", 3, "活动月份").text).toBe("");
    expect(headerCell("惠氏审核结果", 2, "内部自审").text).toBe("Y");
    expect(headerCell("惠氏审核结果", 2, "互动量≥10").text).toBe("N");
    expect(headerCell("惠氏审核结果", 4, "内部自审").text).toBe("未审核");
    expect(headerCell("惠氏审核结果", 4, "互动量≥10").text).toBe("未审核");
    expect(headerCell("惠氏审核结果", 4, "活动月份").text).toBe("9月");
    expect(headerCell("雀巢审核结果", 2, "内部自审").text).toBe("Y");
    expect(headerCell("雀巢审核结果", 2, "互动量≥10").text).toBe("Y");
    expect(headerCell("雀巢审核结果", 3, "互动量≥10").text).toBe("待确认");
    expect(headerCell("惠氏审核结果", 2, "作品类型").text).toBe("视频");
    expect(headerCell("惠氏审核结果", 2, "图片 / 视频审核").text)
      .toBe("视频作品，不参与图片数量审核");
    expect(headerCell("惠氏审核结果", 2, "互动量").value).toBe(9);
    expect(headerCell("雀巢审核结果", 3, "收藏数").value).toBeNull();
    expect(headerCell("雀巢审核结果", 3, "互动量").value).toBeNull();
    for (const sheet of exported.worksheets) {
      const headers = (sheet.getRow(1).values as unknown[]).slice(1);
      expect(headers.filter((header) => header === "互动量≥10")).toHaveLength(1);
      expect(headers.at(-1)).toBe("活动月份");
      expect(headers).toEqual(expect.arrayContaining([
        "作品类型", "审核结论", "公开状态", "话题审核", "图片 / 视频审核",
        "正文审核", "店铺话题审核", "点赞数", "评论数", "收藏数", "互动量", "失败原因",
      ]));
    }
    const danoneExport = exported.getWorksheet("达能审核结果")!;
    expect([danoneExport.getCell("D2").text, danoneExport.getCell("D3").text])
      .toEqual(["澳白", "澳白"]);
    expect([danoneExport.getCell("E2").text, danoneExport.getCell("F2").text])
      .toEqual(["2段", "IFFO"]);
    expect([danoneExport.getCell("E3").text, danoneExport.getCell("F3").text])
      .toEqual(["IFFO", "2段"]);
    expect(headerCell("达能审核结果", 3, "活动月份").text).toBe("");

    const mismatchedTask = await prisma.auditTask.findFirstOrThrow({
      where: { importRecordId, orderNumber: `MIX-WN-${suffix}-0` },
      select: { id: true, notes: true },
    });
    const mismatchedNotes = (mismatchedTask.notes || "").replace(
      '"templateType":"WYETH"',
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
