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
      campaignMatchStatus: "NO_RULES",
      warnings: [],
    });

    sheet.getRow(2).getCell(8).value = "小红书";
    const normalized = await upload(`douyin-normalized-${suffix}.xlsx`);
    expect(normalized.rows[0]).toMatchObject({
      platform: "DOUYIN",
      channel: "DOUYIN",
      contentChannel: "抖音",
      campaignId: douyinCampaign.id,
      campaignMatchStatus: "NO_RULES",
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
