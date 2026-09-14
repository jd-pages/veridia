import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import ExcelJS from "exceljs";

function isolatedDatabase() {
  const datasourceUrl = process.env.E2E_DATABASE_URL?.trim();
  if (!datasourceUrl) throw new Error("预检布局测试只能使用隔离 E2E 数据库");
  return new PrismaClient({ datasourceUrl });
}

async function openExcelImport(page: Page) {
  const tab = page.getByRole("tab", { name: "Excel 自动审核" });
  await expect(tab).toBeVisible();
  await tab.click();
  await expect(page.locator('input[type="file"]')).toHaveCount(1);
}

test("100+ 行预检在三种桌面宽度保持首列与 viewport sticky scrollbar 可用", async ({ page }) => {
  test.setTimeout(90_000);
  expect((await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  })).status()).toBe(200);
  const db = isolatedDatabase();
  const suffix = `${Date.now()}`;
  const product = await db.product.create({
    data: {
      publishedKey: `e2e-preflight-layout-${suffix}`,
      name: `预检布局产品${suffix}`,
      brandName: "达能",
    },
  });
  const campaign = await db.campaign.create({
    data: {
      id: `e2e-preflight-layout-${suffix}`,
      name: `预检布局${suffix}2026年9月小红书审核`,
      month: "2026-09",
      year: 2026,
      contentChannel: "XIAOHONGSHU",
      startDate: new Date("2026-09-01T00:00:00.000Z"),
      endDate: new Date("2026-09-30T23:59:59.000Z"),
      products: { create: [{ productId: product.id }] },
    },
  });
  try {
    const templateResponse = await page.request.get("/api/import/template");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await templateResponse.body()) as unknown as ExcelJS.Buffer);
    const sheet = workbook.getWorksheet("达能客户导入")!;
    if (sheet.rowCount > 1) sheet.spliceRows(2, sheet.rowCount - 1);
    for (let index = 0; index < 120; index += 1) {
      sheet.getRow(index + 2).values = [
        "京东",
        "京东健康官方进口超市",
        `布局客户${index}`,
        product.name,
        "2段",
        "IFFO",
        `LAYOUT-${suffix}-${index}`,
        "小红书",
        `https://xhslink.com/o/layout-${suffix}-${index}`,
        "2026-09-03 12:00:00",
        "9月",
      ];
    }
    await page.goto("/tasks");
    await openExcelImport(page);
    await page.locator('input[type="file"]').setInputFiles({
      name: `preflight-layout-${suffix}.xlsx`,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    });
    await page.getByRole("button", { name: "开始预检查" }).click();
    await expect(page.getByRole("columnheader", { name: "预检结果" })).toBeVisible();

    const tableWrapper = page.locator(".ant-table-wrapper").last();
    const table = tableWrapper.locator(".ant-table");
    const content = table.locator(".ant-table-body");
    const resultHeader = table.getByRole("columnheader", { name: "预检结果" });
    const stickyScroll = tableWrapper.locator(".ant-table-sticky-scroll");
    const pagination = page.locator(".ant-pagination").last();
    for (const viewport of [
      { width: 1366, height: 768 },
      { width: 1440, height: 900 },
      { width: 1920, height: 1080 },
    ]) {
      await page.setViewportSize(viewport);
      await table.evaluate((element) => {
        window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - 120);
      });
      await expect(resultHeader).toBeVisible();
      await expect(stickyScroll).toBeVisible();
      const before = await resultHeader.boundingBox();
      await content.evaluate((element) => {
        element.scrollLeft = element.scrollWidth;
        element.dispatchEvent(new Event("scroll"));
      });
      const after = await resultHeader.boundingBox();
      expect(before).not.toBeNull();
      expect(after).not.toBeNull();
      expect(Math.abs(after!.x - before!.x)).toBeLessThanOrEqual(2);
      expect(after!.x).toBeGreaterThanOrEqual(0);
      expect(after!.x + after!.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      )).toBe(false);

      await page.evaluate(() => window.scrollBy(0, 360));
      await expect(stickyScroll).toBeVisible();
      const [scrollBox, paginationBox] = await Promise.all([
        stickyScroll.boundingBox(),
        pagination.boundingBox(),
      ]);
      expect(scrollBox).not.toBeNull();
      expect(scrollBox!.y + scrollBox!.height).toBeLessThanOrEqual(viewport.height + 1);
      if (paginationBox) {
        expect(
          scrollBox!.y >= paginationBox.y + paginationBox.height ||
          paginationBox.y >= scrollBox!.y + scrollBox!.height,
        ).toBe(true);
      }
    }

    const firstResult = table.locator("tbody tr[data-row-key]").first().locator("td").nth(1);
    await firstResult.hover();
    await expect(page.locator(".ant-tooltip:visible")).toBeVisible();
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.screenshot({
      path: ".playwright/v1.1.32-preflight-after-1366x768.png",
    });
  } finally {
    await db.topicRule.deleteMany({ where: { campaignId: campaign.id } });
    await db.campaign.delete({ where: { id: campaign.id } });
    await db.product.delete({ where: { id: product.id } });
    await db.$disconnect();
  }
});
