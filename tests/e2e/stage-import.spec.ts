import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";
import { E2E_ORIGIN } from "./e2e-origin";

test("Excel按保留的产品阶段话题分组，旧模板额外字段被忽略", async ({
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
    `${E2E_ORIGIN}/mock/xhs?case=passed&stage=${suffix}-pre`,
    product.code,
    product.name,
    "PRE 800g",
    campaign.name,
    campaign.month,
    "IFFO",
    "新模板 IFFO",
  ]);
  sheet.addRow([
    `${E2E_ORIGIN}/mock/xhs?case=passed&stage=${suffix}-gum`,
    product.code,
    product.name,
    "1+段 800g",
    campaign.name,
    campaign.month,
    " gum ",
    "新模板 GUM，兼容空格和大小写",
  ]);
  sheet.addRow([
    `${E2E_ORIGIN}/mock/xhs?case=passed&stage=${suffix}-legacy-p1`,
    product.code,
    product.name,
    "800g",
    campaign.name,
    campaign.month,
    "IFFO：P段/1段",
    "兼容旧 IFFO P1",
  ]);
  sheet.addRow([
    `${E2E_ORIGIN}/mock/xhs?case=passed&stage=${suffix}-legacy-stage-2`,
    product.code,
    product.name,
    "800g",
    campaign.name,
    campaign.month,
    "IFFO：2段",
    "兼容旧 IFFO 2段",
  ]);
  sheet.addRow([
    `${E2E_ORIGIN}/mock/xhs?case=passed&stage=${suffix}-legacy-gum`,
    product.code,
    product.name,
    "800g",
    campaign.name,
    campaign.month,
    "GUM：3段/4段/1+段/2+段",
    "兼容旧 GUM",
  ]);
  sheet.addRow([
    `${E2E_ORIGIN}/mock/xhs?case=passed&stage=${suffix}-invalid-stage`,
    product.code,
    product.name,
    "3段 800g",
    campaign.name,
    campaign.month,
    "3段",
    "具体段位应拒绝",
  ]);
  sheet.addRow([
    `${E2E_ORIGIN}/mock/xhs?case=passed&stage=${suffix}-missing-stage`,
    product.code,
    product.name,
    "800g",
    campaign.name,
    campaign.month,
    "",
    "阶段组必填",
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

  expect(preview.validCount).toBe(5);
  expect(preview.invalidCount).toBe(2);
  expect(preview.rows[0]).toMatchObject({
    productStage: "IFFO",
    stageGroup: "IFFO",
    errors: [],
  });
  expect(preview.rows[1]).toMatchObject({
    productStage: "GUM",
    stageGroup: "GUM",
    errors: [],
  });
  expect(preview.rows[2]).toMatchObject({
    productStage: "IFFO",
    stageGroup: "IFFO",
    errors: [],
  });
  expect(preview.rows[3]).toMatchObject({
    productStage: "IFFO",
    stageGroup: "IFFO",
    errors: [],
  });
  expect(preview.rows[4]).toMatchObject({
    productStage: "GUM",
    stageGroup: "GUM",
    errors: [],
  });
  expect(preview.rows[5].errors).toContain(
    "产品阶段话题请填写 IFFO 或 GUM。",
  );
  expect(preview.rows[6].errors).toContain(
    "产品阶段话题请填写 IFFO 或 GUM。",
  );
  const tasksAfterPreview = (
    await (await page.request.get("/api/tasks")).json()
  ).data.length as number;
  expect(tasksAfterPreview).toBe(tasksBeforePreview);

  const aliasWorkbook = new ExcelJS.Workbook();
  const aliasSheet = aliasWorkbook.addWorksheet("产品别名识别");
  aliasSheet.addRow(["笔记链接", "产品", "活动", "产品阶段话题"]);
  const germanProduct = products.find((item) =>
    item.name.includes("德国白金版"),
  )!;
  const zhiyiProduct = products.find((item) => item.name.includes("至熠"))!;
  const aliasCases = [
    [product.name, product.name],
    [" 澳　白 ", product.name],
    ["澳洲白金", product.name],
    ["德白", germanProduct.name],
    ["至熠", zhiyiProduct.name],
    ["不存在简称", null],
  ] as const;
  aliasCases.forEach(([input], index) => {
    aliasSheet.addRow([
      `${E2E_ORIGIN}/mock/xhs?case=passed&product-alias=${suffix}-${index}`,
      input,
      campaign.name,
      "IFFO",
    ]);
  });
  const aliasResponse = await page.request.post("/api/import/notes", {
    multipart: {
      file: {
        name: "product-alias-import.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: Buffer.from(await aliasWorkbook.xlsx.writeBuffer()),
      },
      commit: "false",
      skipDuplicates: "true",
    },
  });
  expect(aliasResponse.ok()).toBeTruthy();
  const aliasPreview = (await aliasResponse.json()).data as {
    validCount: number;
    invalidCount: number;
    rows: Array<{ productName: string; errors: string[] }>;
  };
  expect(aliasPreview).toMatchObject({ validCount: 5, invalidCount: 1 });
  aliasCases.forEach(([, expectedName], index) => {
    if (expectedName) {
      expect(aliasPreview.rows[index]).toMatchObject({
        productName: expectedName,
        errors: [],
      });
    }
  });
  expect(aliasPreview.rows[5].errors).toContain(
    "产品名称无法识别，请填写系统产品名称或已配置简称。",
  );

  const gumCommitWorkbook = new ExcelJS.Workbook();
  const gumCommitSheet = gumCommitWorkbook.addWorksheet("笔记导入");
  gumCommitSheet.addRow(["笔记链接", "产品", "活动", "产品阶段话题"]);
  const gumCommitUrl = `${E2E_ORIGIN}/mock/xhs?case=passed&stage=${suffix}-gum-commit`;
  gumCommitSheet.addRow([
    gumCommitUrl,
    product.name,
    campaign.name,
    "GUM",
  ]);
  const gumCommitResponse = await page.request.post("/api/import/notes", {
    multipart: {
      file: {
        name: "gum-import.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: Buffer.from(await gumCommitWorkbook.xlsx.writeBuffer()),
      },
      commit: "true",
      skipDuplicates: "true",
    },
  });
  expect(gumCommitResponse.ok()).toBeTruthy();
  expect((await gumCommitResponse.json()).data.imported).toBe(1);
  const committedGumTask = (
    (await (await page.request.get("/api/tasks")).json()).data as Array<{
      url: string;
      productStage: string;
    }>
  ).find((task) => task.url === gumCommitUrl);
  expect(committedGumTask?.productStage).toBe("GUM");

  const newTemplateWorkbook = new ExcelJS.Workbook();
  const newTemplateSheet = newTemplateWorkbook.addWorksheet("笔记导入模板");
  newTemplateSheet.addRow([
    "平台（必填）",
    "店铺名称（必填）",
    "客户名（必填）",
    "产品系列（必填）",
    "阶段（IFFO/GUM）",
    "订单编号（必填）",
    "内容渠道（必填）",
    "链接（必填）",
    "发帖时间（必填）",
  ]);
  const newTemplateUrl = `${E2E_ORIGIN}/mock/xhs?case=passed&new-template=${suffix}`;
  newTemplateSheet.addRow([
    "小红书",
    "E2E 店铺",
    "E2E 客户",
    product.name,
    "IFFO",
    `ORDER-${suffix}`,
    "小红书",
    newTemplateUrl,
    "2026-08-03 12:00:00",
  ]);
  const newTemplateResponse = await page.request.post("/api/import/notes", {
    multipart: {
      file: {
        name: "note-import-new-template.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: Buffer.from(await newTemplateWorkbook.xlsx.writeBuffer()),
      },
      commit: "true",
      skipDuplicates: "true",
    },
  });
  expect(newTemplateResponse.ok()).toBeTruthy();
  expect((await newTemplateResponse.json()).data.imported).toBe(1);
  const committedNewTemplateTask = (
    (await (await page.request.get("/api/tasks")).json()).data as Array<{
      url: string;
      notes: string | null;
      campaignId: string;
    }>
  ).find((task) => task.url === newTemplateUrl);
  expect(committedNewTemplateTask).toMatchObject({
    campaignId: campaign.id,
  });
  expect(committedNewTemplateTask?.notes).toContain("平台：小红书");
  expect(committedNewTemplateTask?.notes).toContain("店铺名称：E2E 店铺");
  expect(committedNewTemplateTask?.notes).toContain("客户名：E2E 客户");
  expect(committedNewTemplateTask?.notes).toContain(
    `订单编号：ORDER-${suffix}`,
  );
  expect(committedNewTemplateTask?.notes).toContain("内容渠道：小红书");
  expect(committedNewTemplateTask?.notes).toContain(
    "发帖时间：2026-08-03 12:00:00",
  );

  const csv = [
    "\uFEFF活动名称,段位,小红书链接,商品,额外登记列",
    `${campaign.name},IFFO,${E2E_ORIGIN}/mock/xhs?case=passed&csv=${suffix},${product.name},忽略`,
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

  const expectedStageTopics = new Map<string, string[]>([
    ["IFFO", ["#新生儿奶粉", "#二段奶粉推荐"]],
    ["GUM", ["#三段奶粉推荐"]],
  ]);
  for (const [stage, expectedTopics] of expectedStageTopics) {
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
    expect(stageRules.map((rule) => rule.topic)).toEqual(
      expect.arrayContaining(expectedTopics),
    );
    expect(stageRules).toHaveLength(expectedTopics.length);
    expect(stageRules.every((rule) => rule.exactMatch)).toBe(true);
    expect(stageRules.every((rule) => rule.clickableRequired)).toBe(true);
  }
});
