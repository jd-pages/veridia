import { expect, test, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { E2E_ORIGIN } from "./e2e-origin";

async function waitForBatch(page: Page, batchId: string) {
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `/api/automation/batches?batchId=${batchId}`,
        );
        const batches = (await response.json()).data as Array<{
          status: string;
        }>;
        return batches[0]?.status;
      },
      { timeout: 45_000 },
    )
    .toBe("COMPLETED");
}

test("Excel 店铺精确映射后，可点击完整店铺话题参与综合审核", async ({
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
    "订单编号",
    "内容渠道",
    "链接（必填）",
    "发帖时间（必填）",
  ]);
  const url = `${E2E_ORIGIN}/mock/xhs?case=aptamil-stage2-store-passed&store-topic=${Date.now()}`;
  sheet.addRow([
    "京东",
    "京东健康官方进口超市",
    "店铺话题 E2E",
    product.name,
    "IFFO",
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
      commit: "true",
      skipDuplicates: "true",
    },
  });
  const payload = await response.json();
  expect(response.ok(), JSON.stringify(payload)).toBeTruthy();
  expect(payload.data.imported).toBe(1);
  await waitForBatch(page, payload.data.batchId);

  const batches = (
    await (
      await page.request.get(
        `/api/automation/batches?batchId=${payload.data.batchId}`,
      )
    ).json()
  ).data as Array<{
    tasks: Array<{
      url: string;
      channel: string | null;
      commercePlatform: string | null;
      storeMappingStatus: string | null;
      auditResults: Array<{
        id: string;
        autoStatus: string;
      }>;
    }>;
  }>;
  const task = batches[0].tasks.find((item) => item.url === url)!;
  expect(task).toMatchObject({
    channel: "XIAOHONGSHU",
    commercePlatform: "JD",
    storeMappingStatus: "MATCHED",
  });
  expect(task.auditResults[0].autoStatus).toBe("PASSED");
  const resultResponse = await page.request.get(
    `/api/results/${task.auditResults[0].id}`,
  );
  expect(resultResponse.ok()).toBeTruthy();
  const result = (await resultResponse.json()).data;
  expect(result).toMatchObject({
    autoStatus: "PASSED",
    storeTopicStatus: "COMPLIANT",
    expectedStoreTopic: "京东健康官方进口超市",
    matchedStoreTopic: "#京东健康官方进口超市",
  });
});
