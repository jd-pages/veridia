import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import ExcelJS from "exceljs";

function isolatedDatabase() {
  const datasourceUrl = process.env.E2E_DATABASE_URL?.trim();
  if (!datasourceUrl) throw new Error("渠道预检测试只能使用隔离 E2E 数据库");
  return new PrismaClient({ datasourceUrl });
}

test("抖音 Excel 预检保持 URL 渠道且只匹配同渠道月份活动", async ({ page }) => {
  expect((await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  })).status()).toBe(200);
  const db = isolatedDatabase();
  const suffix = `${Date.now()}`;
  const product = await db.product.create({
    data: {
      publishedKey: `e2e-import-channel-${suffix}`,
      name: `达能德国白金版渠道测试${suffix}`,
      brandName: "达能",
    },
  });
  const campaignIds: string[] = [];
  try {
    const xhsCampaign = await db.campaign.create({
      data: {
        id: `e2e-import-xhs-sep-${suffix}`,
        name: `渠道测试${suffix}2026年9月小红书审核`,
        month: "2026-09",
        year: 2026,
        contentChannel: "XIAOHONGSHU",
        startDate: new Date("2026-09-01T00:00:00.000Z"),
        endDate: new Date("2026-09-30T23:59:59.000Z"),
        products: { create: [{ productId: product.id }] },
      },
    });
    campaignIds.push(xhsCampaign.id);

    const templateResponse = await page.request.get("/api/import/template");
    expect(templateResponse.ok()).toBeTruthy();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await templateResponse.body()) as unknown as ExcelJS.Buffer);
    const sheet = workbook.getWorksheet("达能客户导入")!;
    if (sheet.rowCount > 1) sheet.spliceRows(2, sheet.rowCount - 1);
    sheet.getRow(2).values = [
      "抖音",
      "抖音店铺",
      `渠道客户${suffix}`,
      product.name,
      "2段",
      "IFFO",
      `CHANNEL-${suffix}`,
      "抖音",
      "https://v.douyin.com/example/",
      "2026-09-03 12:00:00",
      "9月",
    ];
    const upload = async (name: string) => {
      const response = await page.request.post("/api/import/notes", {
        multipart: {
          file: {
            name,
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
          },
          commit: "false",
          skipDuplicates: "true",
        },
      });
      if (!response.ok()) {
        throw new Error(`预检失败 ${response.status()}：${await response.text()}`);
      }
      return (await response.json()).data as {
        rows: Array<{
          platform: string;
          channel: string;
          contentChannel: string;
          campaignId?: string;
          campaignName: string;
          campaignMatchStatus: string;
          campaignRuleCount: number;
          warnings: Array<{ code: string; message: string }>;
          errors: string[];
        }>;
      };
    };

    const missingDouyin = await upload(`douyin-missing-${suffix}.xlsx`);
    expect(missingDouyin.rows[0]).toMatchObject({
      platform: "DOUYIN",
      channel: "DOUYIN",
      contentChannel: "抖音",
      campaignName: "",
      campaignMatchStatus: "ACTIVITY_NOT_FOUND",
    });
    expect(missingDouyin.rows[0].errors.join("；")).toContain("未找到9月对应的抖音活动");
    expect(missingDouyin.rows[0].errors.join("；")).not.toContain("小红书活动");

    const douyinCampaign = await db.campaign.create({
      data: {
        id: `e2e-import-dy-sep-${suffix}`,
        name: `渠道测试${suffix}2026年9月抖音审核`,
        month: "2026-09",
        year: 2026,
        contentChannel: "DOUYIN",
        startDate: new Date("2026-09-01T00:00:00.000Z"),
        endDate: new Date("2026-09-30T23:59:59.000Z"),
        products: { create: [{ productId: product.id }] },
      },
    });
    campaignIds.push(douyinCampaign.id);
    const matchedDouyin = await upload(`douyin-matched-${suffix}.xlsx`);
    expect(matchedDouyin.rows[0]).toMatchObject({
      platform: "DOUYIN",
      channel: "DOUYIN",
      contentChannel: "抖音",
      campaignId: douyinCampaign.id,
      campaignName: douyinCampaign.name,
      campaignMatchStatus: "MATCHED",
      warnings: [],
    });
    expect(matchedDouyin.rows[0].campaignRuleCount).toBeGreaterThan(0);

    sheet.getRow(2).getCell(8).value = "小红书";
    const normalized = await upload(`douyin-normalized-${suffix}.xlsx`);
    expect(normalized.rows[0]).toMatchObject({
      platform: "DOUYIN",
      channel: "DOUYIN",
      contentChannel: "抖音",
      campaignId: douyinCampaign.id,
      campaignMatchStatus: "MATCHED",
      warnings: [expect.objectContaining({ code: "CHANNEL_NORMALIZED_FROM_URL" })],
    });
  } finally {
    await db.topicRule.deleteMany({ where: { campaignId: { in: campaignIds } } });
    await db.campaign.deleteMany({ where: { id: { in: campaignIds } } });
    await db.product.delete({ where: { id: product.id } });
    await db.$disconnect();
  }
});

test("产品无法识别时不追加依赖产品的活动不存在错误", async ({ page }) => {
  expect((await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  })).status()).toBe(200);
  const templateResponse = await page.request.get("/api/import/template");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await templateResponse.body()) as unknown as ExcelJS.Buffer);
  const sheet = workbook.getWorksheet("达能客户导入")!;
  if (sheet.rowCount > 1) sheet.spliceRows(2, sheet.rowCount - 1);
  sheet.getRow(2).values = [
    "抖音", "抖音店铺", "未知产品客户", "绝对不存在的产品名称", "2段", "IFFO",
    `UNKNOWN-${Date.now()}`, "抖音", "https://v.douyin.com/example/", "2026-09-03 12:00:00", "9月",
  ];
  const response = await page.request.post("/api/import/notes", {
    multipart: {
      file: {
        name: "unknown-product-channel.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
      },
      commit: "false",
      skipDuplicates: "true",
    },
  });
  expect(response.ok()).toBeTruthy();
  const row = (await response.json()).data.rows[0] as { errors: string[] };
  expect(row.errors.join("；")).toContain("产品");
  expect(row.errors.join("；")).not.toContain("ACTIVITY_NOT_FOUND");
  expect(row.errors.join("；")).not.toContain("未找到9月对应");
});

test("佳贝艾特预检复用正式 Effective Rules 并仅在有效集为零时报错", async ({ page }) => {
  expect((await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  })).status()).toBe(200);
  const db = isolatedDatabase();
  const suffix = `${Date.now()}`;
  const product = await db.product.create({
    data: {
      publishedKey: `e2e-kabrita-effective-${suffix}`,
      name: `佳贝艾特有效规则验收产品${suffix}`,
      brandName: "佳贝艾特",
    },
  });
  const campaign = await db.campaign.create({
    data: {
      id: `e2e-kabrita-effective-campaign-${suffix}`,
      name: `佳贝艾特2039年9月有效规则验收${suffix}`,
      month: "2039-09",
      year: 2039,
      contentChannel: "XIAOHONGSHU",
      startDate: new Date("2039-09-01T00:00:00.000Z"),
      endDate: new Date("2039-09-30T23:59:59.000Z"),
      products: { create: [{ productId: product.id }] },
    },
  });
  const createdRuleIds: string[] = [];
  try {
    const templateResponse = await page.request.get("/api/import/template");
    expect(templateResponse.ok()).toBeTruthy();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await templateResponse.body()) as unknown as ExcelJS.Buffer,
    );
    const sheet = workbook.getWorksheet("佳贝艾特客户导入")!;
    if (sheet.rowCount > 1) sheet.spliceRows(2, sheet.rowCount - 1);
    sheet.getRow(2).values = [
      "", "京东", "佳贝艾特(Kabrita)海外专卖店", "", "", "", "", "", "", "",
      `https://www.xiaohongshu.com/explore/effective-${suffix}`,
      product.name,
      "2039-09",
      "",
    ];
    const upload = async () => {
      const response = await page.request.post("/api/import/notes", {
        multipart: {
          file: {
            name: `kabrita-effective-${suffix}.xlsx`,
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
          },
          commit: "false",
          skipDuplicates: "true",
        },
      });
      const payload = await response.json();
      expect(response.ok(), JSON.stringify(payload)).toBeTruthy();
      return payload.data.rows[0] as {
        campaignId: string;
        campaignMatchStatus: string;
        campaignRuleCount: number;
        effectiveRuleIds: string[];
        effectiveRuleCounts: { GLOBAL: number; PRODUCT: number; CAMPAIGN: number };
        errors: string[];
      };
    };
    const auditRuleIds = async () => {
      const response = await page.request.get(
        `/api/campaigns/${campaign.id}/requirements?productId=${product.id}&stage=IFFO`,
      );
      const payload = await response.json();
      expect(response.ok(), JSON.stringify(payload)).toBeTruthy();
      return (payload.data.context.rules as Array<{ id: string }>).map(
        (rule) => rule.id,
      );
    };

    const globalRule = await db.topicRule.create({
      data: {
        scope: "GLOBAL",
        brandName: "佳贝艾特",
        contentChannel: "XIAOHONGSHU",
        ruleType: "MUST_ALL",
        topicCategory: "BRAND_COMMON",
        topic: `#佳贝艾特有效规则${suffix}`,
      },
    });
    createdRuleIds.push(globalRule.id);
    const globalOnly = await upload();
    const globalOnlyAuditRuleIds = await auditRuleIds();
    expect(globalOnly).toMatchObject({
      campaignId: campaign.id,
      campaignMatchStatus: "MATCHED",
      errors: [],
    });
    expect(globalOnly.effectiveRuleIds).toContain(globalRule.id);
    expect(globalOnly.campaignRuleCount).toBe(globalOnlyAuditRuleIds.length);
    expect(globalOnly.effectiveRuleIds).toEqual(globalOnlyAuditRuleIds);

    const productRule = await db.topicRule.create({
      data: {
        scope: "PRODUCT",
        brandName: "佳贝艾特",
        productId: product.id,
        campaignId: campaign.id,
        contentChannel: "XIAOHONGSHU",
        ruleType: "MUST_ALL",
        topicCategory: "PRODUCT_COMMON",
        topic: `#佳贝艾特产品有效规则${suffix}`,
      },
    });
    createdRuleIds.push(productRule.id);
    const globalAndProduct = await upload();
    const globalAndProductAuditRuleIds = await auditRuleIds();
    expect(globalAndProduct).toMatchObject({
      campaignMatchStatus: "MATCHED",
      errors: [],
    });
    expect(globalAndProduct.effectiveRuleIds).toContain(productRule.id);
    expect(globalAndProduct.campaignRuleCount).toBe(
      globalAndProductAuditRuleIds.length,
    );
    expect(globalAndProduct.effectiveRuleIds).toEqual(
      globalAndProductAuditRuleIds,
    );
    expect(globalAndProduct.effectiveRuleCounts.PRODUCT).toBe(1);
  } finally {
    if (createdRuleIds.length) {
      await db.topicRule.deleteMany({ where: { id: { in: createdRuleIds } } });
    }
    await db.campaign.delete({ where: { id: campaign.id } });
    await db.product.delete({ where: { id: product.id } });
    await db.$disconnect();
  }
});

test("Campaign 已匹配但 Effective Rules 全为零时返回 NO_EFFECTIVE_RULES", async ({ page }) => {
  expect((await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  })).status()).toBe(200);
  const db = isolatedDatabase();
  const suffix = `${Date.now()}`;
  const product = await db.product.create({
    data: {
      publishedKey: `e2e-wyeth-no-effective-${suffix}`,
      name: `惠氏无有效规则产品${suffix}`,
      brandName: "惠氏",
    },
  });
  const campaign = await db.campaign.create({
    data: {
      id: `e2e-wyeth-no-effective-campaign-${suffix}`,
      name: `惠氏2038年9月无有效规则验收${suffix}`,
      month: "2038-09",
      year: 2038,
      contentChannel: "XIAOHONGSHU",
      startDate: new Date("2038-09-01T00:00:00.000Z"),
      endDate: new Date("2038-09-30T23:59:59.000Z"),
      products: { create: [{ productId: product.id }] },
    },
  });
  try {
    const templateResponse = await page.request.get("/api/import/template");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await templateResponse.body()) as unknown as ExcelJS.Buffer,
    );
    const sheet = workbook.getWorksheet("惠氏客户导入")!;
    if (sheet.rowCount > 1) sheet.spliceRows(2, sheet.rowCount - 1);
    sheet.getRow(2).values = [
      "验收人",
      "验收客户",
      "京东",
      "未配置店铺",
      product.name,
      `NO-EFFECTIVE-${suffix}`,
      "小红书",
      `https://www.xiaohongshu.com/explore/no-effective-${suffix}`,
      "2038-09-03 12:00:00",
      "2038-09",
      "",
      "",
      "",
    ];
    const response = await page.request.post("/api/import/notes", {
      multipart: {
        file: {
          name: `wyeth-no-effective-${suffix}.xlsx`,
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
        },
        commit: "false",
        skipDuplicates: "true",
      },
    });
    const payload = await response.json();
    expect(response.ok(), JSON.stringify(payload)).toBeTruthy();
    expect(payload.data.rows[0]).toMatchObject({
      campaignId: campaign.id,
      campaignMatchStatus: "NO_EFFECTIVE_RULES",
      campaignRuleCount: 0,
      effectiveRuleIds: [],
      effectiveRuleCounts: { GLOBAL: 0, PRODUCT: 0, CAMPAIGN: 0 },
    });
    expect(payload.data.rows[0].errors.join("；")).toContain(
      "当前品牌 / 产品 / 活动 / 渠道下没有可用审核规则",
    );
  } finally {
    await db.campaign.delete({ where: { id: campaign.id } });
    await db.product.delete({ where: { id: product.id } });
    await db.$disconnect();
  }
});
