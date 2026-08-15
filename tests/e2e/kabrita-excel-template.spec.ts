import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";
import { E2E_ORIGIN } from "./e2e-origin";

const importHeaders = [
  "登记时间",
  "渠道",
  "店铺名称",
  "客户备注",
  "买家购买ID",
  "购买订单号",
  "购买时间",
  "购买罐数",
  "参与次数",
  "发布小红书账号",
  "小红书发布链接",
  "购买产品线",
  "活动名称（必填）",
];

const exportHeaders = [...importHeaders.slice(0, -1), "活动名称", "自审"];

test("佳贝艾特13列导入模板下载、识别和六种购买产品线预检", async ({
  page,
}) => {
  const login = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(login.ok()).toBeTruthy();

  const templateResponse = await page.request.get(
    "/api/import/template?format=xlsx&brand=kabrita",
  );
  expect(templateResponse.ok()).toBeTruthy();
  const templateWorkbook = new ExcelJS.Workbook();
  await templateWorkbook.xlsx.load(
    (await templateResponse.body()) as unknown as ExcelJS.Buffer,
  );
  expect(templateWorkbook.worksheets[0].rowCount).toBe(2);
  expect(
    (templateWorkbook.worksheets[0].getRow(1).values as unknown[]).slice(1),
  ).toEqual(importHeaders);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("佳贝艾特导入");
  sheet.addRow(importHeaders);
  const productLines = [
    "荷兰佳贝1",
    "荷兰佳贝2",
    "荷兰佳贝3",
    "港版佳贝1",
    "港版佳贝2",
    "港版佳贝3",
  ];
  productLines.forEach((productLine, index) => {
    sheet.addRow([
      "",
      "京东",
      "佳贝艾特(Kabrita)海外专卖店",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      `标题 ${E2E_ORIGIN}/mock/xhs?case=passed&kabrita=${index + 1}`,
      productLine,
      "佳贝艾特2026年8月小红书种草审核",
    ]);
  });

  const previewResponse = await page.request.post("/api/import/notes", {
    multipart: {
      file: {
        name: "佳贝艾特审核模板.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
      },
      commit: "false",
      skipDuplicates: "true",
    },
  });
  const payload = await previewResponse.json();
  expect(
    previewResponse.ok(),
    `佳贝艾特预检失败：${JSON.stringify(payload)}`,
  ).toBeTruthy();
  const preview = payload.data as {
    templateBrand: string;
    sourceLabel: string;
    validCount: number;
    invalidCount: number;
    recognizedFields: Array<{ header: string }>;
    rows: Array<{
      purchaseProductLine: string;
      productName: string;
      campaignName: string;
      month: string;
      errors: string[];
    }>;
  };
  expect(preview).toMatchObject({
    templateBrand: "佳贝艾特",
    sourceLabel: "佳贝艾特 Excel",
    validCount: 6,
    invalidCount: 0,
  });
  expect(preview.recognizedFields.map((field) => field.header)).toEqual(
    importHeaders,
  );
  expect(preview.rows.map((row) => row.purchaseProductLine)).toEqual(
    productLines,
  );
  expect(preview.rows.slice(0, 3).map((row) => row.productName)).toEqual([
    "佳贝艾特荷兰版",
    "佳贝艾特荷兰版",
    "佳贝艾特荷兰版",
  ]);
  expect(preview.rows.slice(3).map((row) => row.productName)).toEqual([
    "佳贝艾特港版",
    "佳贝艾特港版",
    "佳贝艾特港版",
  ]);
  expect(preview.rows.flatMap((row) => row.errors)).toEqual([]);
  expect(preview.rows.every((row) => row.month === "2026-08")).toBe(true);
  expect(
    preview.rows.every((row) =>
      row.campaignName.includes("佳贝艾特2026年8月"),
    ),
  ).toBe(true);
});

test("佳贝艾特内容合规与基础奖励共同决定最终结论和14列导出", async ({
  page,
}) => {
  const login = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(login.ok()).toBeTruthy();

  const products = (await (await page.request.get("/api/products")).json())
    .data as Array<{ id: string; name: string; brandName: string }>;
  const product = products.find(
    (item) => item.name === "佳贝艾特荷兰版" && item.brandName === "佳贝艾特",
  )!;
  const campaigns = (await (await page.request.get("/api/campaigns")).json())
    .data as Array<{ id: string; name: string }>;
  const campaign = campaigns.find(
    (item) => item.name === "佳贝艾特2026年8月小红书种草审核",
  )!;
  expect(product).toBeTruthy();
  expect(campaign).toBeTruthy();

  const audit = async ({
    marker,
    likeCount,
    favoriteCount,
    commentCount,
    interactionExtractionStatus = "SUCCESS",
    topics = [
      "#初见小温柔成长更友好",
      "#佳贝艾特荷兰版",
      "#羊奶粉推荐婴儿",
      "#好消化吸收的奶粉",
    ],
    pageStatus = "NORMAL",
  }: {
    marker: string;
    likeCount?: number | null;
    favoriteCount?: number | null;
    commentCount?: number | null;
    interactionExtractionStatus?: "SUCCESS" | "UNAVAILABLE";
    topics?: string[];
    pageStatus?: "NORMAL" | "NOTE_NOT_FOUND";
  }) => {
    const url = `${E2E_ORIGIN}/mock/xhs?case=passed&kabrita-reward=${marker}-${Date.now()}`;
    const createResponse = await page.request.post("/api/tasks", {
      data: {
        urls: url,
        productId: product.id,
        campaignId: campaign.id,
        productStage: "IFFO_2",
        skipDuplicates: true,
      },
    });
    expect(createResponse.ok()).toBeTruthy();
    const task = (await createResponse.json()).data.created[0] as { id: string };
    const auditResponse = await page.request.post(`/api/tasks/${task.id}/audit`, {
      data: {
        extraction: {
          url,
          finalUrl: url,
          noteId: `kabrita-reward-${marker}-${Date.now()}`,
          title: "佳贝艾特基础奖励审核",
          body: `宝宝目前喝2段奶粉，${"这是一段真实的佳贝艾特喂养体验记录".repeat(5)}`,
          noteType: "IMAGE_TEXT",
          imageExtractionStatus: "SUCCESS",
          imageCount: 3,
          likeCount,
          favoriteCount,
          commentCount,
          interactionExtractionStatus,
          topics: topics.map((displayText) => ({
            displayText,
            isLinkElement: true,
            hasHref: true,
            href: `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(displayText)}`,
            styleFeature: true,
          })),
          pageStatus,
          isPublic: pageStatus === "NORMAL",
          extractedAt: new Date().toISOString(),
          adapterName: "playwright-xiaohongshu",
          adapterVersion: "1.5.0",
        },
      },
    });
    expect(auditResponse.ok()).toBeTruthy();
    return (await auditResponse.json()).data as {
      id: string;
      autoStatus: string;
      failureReasons: string;
    };
  };

  const passed = await audit({
    marker: "passed",
    likeCount: 176,
    favoriteCount: 94,
    commentCount: 4,
  });
  expect(passed.autoStatus).toBe("PASSED");

  const below = await audit({
    marker: "below",
    likeCount: 3,
    favoriteCount: 3,
    commentCount: 3,
  });
  expect(below.autoStatus).toBe("FAILED");
  expect(JSON.parse(below.failureReasons)).toContain(
    "基础奖励未达成：互动合计 9",
  );

  const contentFailed = await audit({
    marker: "content-failed",
    likeCount: 176,
    favoriteCount: 94,
    commentCount: 4,
    topics: [
      "#初见小温柔成长更友好",
      "#羊奶粉推荐婴儿",
      "#好消化吸收的奶粉",
    ],
  });
  expect(contentFailed.autoStatus).toBe("FAILED");
  expect(JSON.parse(contentFailed.failureReasons).join("；")).toContain(
    "缺少精确话题 #佳贝艾特荷兰版",
  );

  const unreadable = await audit({
    marker: "unreadable",
    likeCount: null,
    favoriteCount: null,
    commentCount: null,
    interactionExtractionStatus: "UNAVAILABLE",
  });
  expect(unreadable.autoStatus).toBe("NEEDS_REVIEW");

  const unavailable = await audit({
    marker: "not-found",
    pageStatus: "NOTE_NOT_FOUND",
    interactionExtractionStatus: "UNAVAILABLE",
  });
  expect(unavailable.autoStatus).toBe("NOTE_NOT_FOUND");

  const expectedExports = [
    [passed.id, "Y"],
    [below.id, "N-其他不合规；基础奖励未达成：互动合计 9"],
    [
      contentFailed.id,
      "N-缺少话题；缺少必带话题：#佳贝艾特荷兰版",
    ],
    [unreadable.id, ""],
    [unavailable.id, "N-帖子无法查看；页面无法访问：小红书页面提示“你访问的页面不见了”"],
  ] as const;
  for (const [id, expected] of expectedExports) {
    const exportResponse = await page.request.get(`/api/results/export?ids=${id}`);
    expect(exportResponse.ok()).toBeTruthy();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await exportResponse.body()) as unknown as ExcelJS.Buffer,
    );
    expect(
      (workbook.worksheets[0].getRow(1).values as unknown[]).slice(1),
    ).toEqual(exportHeaders);
    expect(workbook.worksheets[0].getCell("N2").text).toBe(expected);
  }

  await page.goto(`/results/${passed.id}`);
  const rewardCard = page.locator("article", {
    has: page.getByRole("heading", { name: "基础奖励" }),
  });
  await expect(rewardCard).toContainText("点赞数176");
  await expect(rewardCard).toContainText("收藏数94");
  await expect(rewardCard).toContainText("评论数4");
  await expect(rewardCard).toContainText("合计互动数274");
  await expect(rewardCard).toContainText("基础奖励已达成");
  await expect(rewardCard).toContainText("最终审核结论通过");
});
