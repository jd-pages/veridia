import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";
import { E2E_ORIGIN } from "./e2e-origin";

test("Excel 店铺忽略英文大小写完成精确映射", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const login = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(login.ok()).toBeTruthy();

  const products = (await (await page.request.get("/api/products")).json())
    .data as Array<{ id: string; name: string }>;
  const product = products.find((item) => item.name === "爱他美澳洲白金版")!;
  expect(product).toBeTruthy();
  const campaigns = (
    await (await page.request.get(`/api/campaigns?productId=${product.id}`)).json()
  ).data as Array<{ id: string; name: string }>;
  const campaign = campaigns.find((item) => item.name.includes("爱他美2026年7月"))!;
  expect(campaign).toBeTruthy();

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("店铺话题审核");
  sheet.addRow([
    "平台",
    "店铺名称（必填）",
    "客户名（必填）",
    "产品系列（必填）",
    "阶段（IFFO/GUM）",
    "段位",
    "订单编号",
    "内容渠道",
    "链接（必填）",
    "发帖时间（必填）",
  ]);
  const url = `${E2E_ORIGIN}/mock/xhs?case=aptamil-stage2-folo-store-passed&store-topic=${Date.now()}`;
  sheet.addRow([
    "天猫",
    "FOLO海外专营店",
    "店铺话题 E2E",
    product.name,
    "IFFO",
    "2段",
    `STORE-${Date.now()}`,
    "小红书",
    url,
    "2026-08-05 12:00:00",
  ]);

  const response = await page.request.post("/api/import/notes", {
    multipart: {
      file: {
        name: "store-topic-audit.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
      },
      commit: "false",
      skipDuplicates: "true",
    },
  });
  const payload = await response.json();
  expect(response.ok(), JSON.stringify(payload)).toBeTruthy();
  expect(payload.data.validCount).toBe(1);
  expect(payload.data.invalidCount).toBe(0);
  expect(payload.data.rows[0]).toMatchObject({
    shopName: "FOLO海外专营店",
    channel: "XIAOHONGSHU",
    commercePlatform: "TMALL",
    storeMappingStatus: "MATCHED",
    matchedStoreName: "folo海外专营店",
    expectedStoreTopic: "#folo海外专营店",
  });
});
