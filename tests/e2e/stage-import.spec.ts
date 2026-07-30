import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";

test("Excel按产品名称、规格和段位分组识别，并拦截跨组冲突", async ({
  page,
}) => {
  const loginResponse = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(loginResponse.ok()).toBeTruthy();

  const productsResponse = await page.request.get("/api/products");
  const products = (await productsResponse.json()).data as Array<{
    id: string;
    code: string | null;
    name: string;
  }>;
  const product =
    products.find((item) => item.name.includes("澳洲白金版")) || products[0];
  expect(product).toBeTruthy();

  const campaignsResponse = await page.request.get(
    `/api/campaigns?productId=${product.id}`,
  );
  const campaigns = (await campaignsResponse.json()).data as Array<{
    id: string;
    name: string;
    month: string;
  }>;
  const campaign =
    campaigns.find((item) => item.name.includes("爱他美2026年7月")) ||
    campaigns[0];
  expect(campaign).toBeTruthy();

  const suffix = Date.now();
  const tasksBeforePreview = (
    await (await page.request.get("/api/tasks")).json()
  ).data.length as number;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("段位识别");
  sheet.addRow([
    "笔记链接",
    "产品编码",
    "产品名称",
    "规格",
    "活动名称",
    "活动月份",
    "产品阶段话题",
    "备注",
  ]);
  sheet.addRow([
    `http://localhost:3100/mock/xhs?case=passed&stage=${suffix}-pre`,
    product.code,
    product.name,
    "PRE 800g",
    campaign.name,
    campaign.month,
    "",
    "从规格识别PRE",
  ]);
  sheet.addRow([
    `http://localhost:3100/mock/xhs?case=passed&stage=${suffix}-gum`,
    product.code,
    product.name,
    "1+段 800g",
    campaign.name,
    campaign.month,
    "",
    "优先识别1+段",
  ]);
  sheet.addRow([
    `http://localhost:3100/mock/xhs?case=passed&stage=${suffix}-stage-2`,
    product.code,
    product.name,
    "800g",
    campaign.name,
    campaign.month,
    "2段",
    "从段位字段识别2段",
  ]);
  sheet.addRow([
    `http://localhost:3100/mock/xhs?case=passed&stage=${suffix}-conflict`,
    product.code,
    product.name,
    "1段 800g",
    campaign.name,
    campaign.month,
    "2段",
    "跨组冲突",
  ]);

  const response = await page.request.post("/api/import/notes", {
    multipart: {
      file: {
        name: "stage-import.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
      },
      commit: "false",
      skipDuplicates: "true",
    },
  });
  expect(response.ok()).toBeTruthy();
  const preview = (await response.json()).data as {
    validCount: number;
    invalidCount: number;
    rows: Array<{
      productStage: string;
      stageGroup: string;
      errors: string[];
    }>;
  };

  expect(preview.validCount).toBe(3);
  expect(preview.invalidCount).toBe(1);
  expect(preview.rows[0]).toMatchObject({
    productStage: "IFFO_P1",
    stageGroup: "IFFO：P段/1段",
    errors: [],
  });
  expect(preview.rows[1]).toMatchObject({
    productStage: "GUM_3_4_1PLUS_2PLUS",
    stageGroup: "GUM：3段/4段/1+段/2+段",
    errors: [],
  });
  expect(preview.rows[2]).toMatchObject({
    productStage: "IFFO_2",
    stageGroup: "IFFO：2段",
    errors: [],
  });
  expect(preview.rows[3].productStage).toBe("");
  expect(preview.rows[3].errors.join("；")).toContain("段位信息冲突");
  const tasksAfterPreview = (
    await (await page.request.get("/api/tasks")).json()
  ).data.length as number;
  expect(tasksAfterPreview).toBe(tasksBeforePreview);

  const csv = [
    "\uFEFF活动名称,段位,小红书链接,商品,额外登记列",
    `${campaign.name},2段,http://localhost:3100/mock/xhs?case=passed&csv=${suffix},${product.name},忽略`,
  ].join("\r\n");
  const csvResponse = await page.request.post("/api/import/notes", {
    multipart: {
      file: {
        name: "腾讯文档导出.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(csv, "utf8"),
      },
      commit: "false",
      skipDuplicates: "true",
      tencentExport: "true",
    },
  });
  expect(csvResponse.ok()).toBeTruthy();
  const csvPreview = (await csvResponse.json()).data as {
    sourceType: string;
    templateVersion: string;
    validCount: number;
    unknownHeaders: string[];
  };
  expect(csvPreview).toMatchObject({
    sourceType: "TENCENT_DOCS_EXPORTED_CSV",
    templateVersion: "template-2026.07.30.1",
    validCount: 1,
    unknownHeaders: ["额外登记列"],
  });

  const expectedStageTopics = new Map([
    ["IFFO_P1", "#新生儿奶粉"],
    ["IFFO_2", "#二段奶粉推荐"],
    ["GUM_3_4_1PLUS_2PLUS", "#三段奶粉推荐"],
  ]);
  for (const [stage, expectedTopic] of expectedStageTopics) {
    const requirementsResponse = await page.request.get(
      `/api/campaigns/${campaign.id}/requirements?productId=${encodeURIComponent(product.id)}&stage=${encodeURIComponent(stage)}`,
    );
    expect(requirementsResponse.ok()).toBeTruthy();
    const requirements = (await requirementsResponse.json()).data as {
      context: {
        rules: Array<{
          topic: string;
          topicCategory: string;
          exactMatch: boolean;
          clickableRequired: boolean;
        }>;
      };
    };
    const stageRules = requirements.context.rules.filter(
      (rule) => rule.topicCategory === "PRODUCT_STAGE",
    );
    expect(stageRules).toHaveLength(1);
    expect(stageRules[0]).toMatchObject({
      topic: expectedTopic,
      exactMatch: true,
      clickableRequired: true,
    });
  }
});
