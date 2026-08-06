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
    .toMatch(/COMPLETED|FAILED|CANCELLED/u);
}

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
    "发布时间（必填）",
    "活动名称（必填）",
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
    campaign.name,
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

test("同一店铺任意命中第二条可点击话题即通过并保存结构化快照", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const login = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(login.ok()).toBeTruthy();

  const suffix = String(Date.now()).slice(-8);
  const storeName = `ROCKCHECK${suffix}海外专营店`;
  const alternateTopic = "ROCKCHECK海外旗舰店";
  const createdResponse = await page.request.post("/api/store-topic-rules", {
    data: {
      commercePlatform: "TMALL",
      storeName,
      enabled: true,
      acceptedTopics: [{ topic: storeName }, { topic: alternateTopic }],
      requiredTopics: [{ topic: "天猫" }],
    },
  });
  const createdPayload = await createdResponse.json();
  expect(createdResponse.ok(), JSON.stringify(createdPayload)).toBeTruthy();
  const storeRuleId = createdPayload.data.id as string;

  try {
    const products = (await (await page.request.get("/api/products")).json())
      .data as Array<{ id: string; name: string }>;
    const product = products.find((item) => item.name === "爱他美澳洲白金版")!;
    const campaigns = (
      await (await page.request.get(`/api/campaigns?productId=${product.id}`)).json()
    ).data as Array<{ id: string; name: string }>;
    const campaign = campaigns.find((item) => item.name.includes("爱他美2026年8月"))!;
    expect(product).toBeTruthy();
    expect(campaign).toBeTruthy();

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("多店铺话题审核");
    sheet.addRow([
      "平台（必填）",
      "店铺名称（必填）",
      "客户名（必填）",
      "产品系列（必填）",
      "阶段（必填）",
      "段位（必填）",
      "订单编号（必填）",
      "内容渠道（必填）",
      "链接（必填）",
      "发布时间（必填）",
      "活动名称（必填）",
    ]);
    const marker = `accepted-topic-${suffix}`;
    const url = `${E2E_ORIGIN}/mock/xhs?case=aptamil-stage2-rockcheck-store-passed&${marker}`;
    sheet.addRow([
      "天猫",
      storeName,
      "多话题 E2E",
      product.name,
      "2段",
      "IFFO",
      `MULTI-${suffix}`,
      "小红书",
      url,
      "2026-08-05 12:00:00",
      campaign.name,
    ]);
    const metadata = workbook.addWorksheet("VERIDIA模板信息", {
      state: "veryHidden",
    });
    metadata.getCell("B1").value = "DANONE_CUSTOMER";

    const response = await page.request.post("/api/import/notes", {
      multipart: {
        file: {
          name: "store-accepted-topics.xlsx",
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
    expect(payload.data.validCount).toBe(1);
    expect(payload.data.rows[0].expectedStoreTopics).toEqual([
      `#${storeName}`,
      `#${alternateTopic}`,
    ]);
    expect(payload.data.rows[0].requiredStoreTopics).toEqual(["#天猫"]);
    await waitForBatch(page, payload.data.batchId);

    const resultsResponse = await page.request.get(
      `/api/results?batchId=${encodeURIComponent(payload.data.batchId)}&pageSize=10`,
    );
    const results = (await resultsResponse.json()).data.items as Array<{
      id: string;
      storeTopicStatus: string;
      expectedStoreTopics: string;
      matchedStoreTopics: string;
      requiredStoreTopics: string;
      matchedRequiredStoreTopics: string;
      autoStatus: string;
    }>;
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      storeTopicStatus: "COMPLIANT",
      autoStatus: "PASSED",
    });
    expect(JSON.parse(results[0].expectedStoreTopics)).toEqual([
      `#${storeName}`,
      `#${alternateTopic}`,
    ]);
    expect(JSON.parse(results[0].matchedStoreTopics)).toEqual([
      "#ROCKCHECK海外旗舰店",
    ]);
    expect(JSON.parse(results[0].requiredStoreTopics)).toEqual(["#天猫"]);
    expect(JSON.parse(results[0].matchedRequiredStoreTopics)).toEqual([
      "#天猫",
    ]);

    const detail = (await (
      await page.request.get(`/api/results/${results[0].id}`)
    ).json()).data;
    expect(JSON.parse(detail.expectedStoreTopics)).toHaveLength(2);
  } finally {
    await page.request.delete(`/api/store-topic-rules/${storeRuleId}`);
  }
});
