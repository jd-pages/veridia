import { expect, test } from "@playwright/test";
import { E2E_ORIGIN } from "./e2e-origin";

test("产品阶段话题只显示 IFFO / GUM，并匹配底层对应话题", async ({
  page,
}) => {
  const loginResponse = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(loginResponse.ok()).toBeTruthy();

  await page.goto("/tasks");
  await expect(
    page.getByRole("combobox", { name: "所属活动" }),
  ).toBeVisible();
  await expect(page.getByRole("combobox", { name: "所属产品" })).toBeDisabled();
  await expect(
    page.getByRole("combobox", { name: "产品阶段话题" }),
  ).toHaveCount(0);
  await expect(page.getByText("请选择 IFFO 或 GUM。", { exact: true })).toHaveCount(0);

  const products = (
    await (await page.request.get("/api/products")).json()
  ).data as Array<{ id: string; name: string }>;
  const product =
    products.find((item) => item.name.includes("澳洲白金版")) || products[0];
  const campaigns = (
    await (
      await page.request.get(`/api/campaigns?productId=${product.id}`)
    ).json()
  ).data as Array<{ id: string; name: string }>;
  const campaign = campaigns.find((item) =>
    item.name.includes("爱他美2026年7月"),
  );
  expect(campaign).toBeTruthy();

  await page.getByRole("combobox", { name: "所属活动" }).click();
  await page
    .locator(".ant-select-dropdown:visible .ant-select-item-option")
    .filter({ hasText: campaign!.name })
    .click();
  await expect(
    page.getByRole("combobox", { name: "产品阶段话题" }),
  ).toBeVisible();
  await expect(page.getByText("请选择 IFFO 或 GUM。", { exact: true })).toBeVisible();

  await page.getByRole("combobox", { name: "所属产品" }).click();
  const productOptions = page.locator(
    ".ant-select-dropdown:visible .ant-select-item-option",
  );
  await expect(productOptions.filter({ hasText: "佳贝艾特" })).toHaveCount(0);
  await page
    .locator(".ant-select-dropdown:visible .ant-select-item-option")
    .filter({ hasText: product.name })
    .click();

  const stageSelect = page.getByRole("combobox", {
    name: "产品阶段话题",
  });
  const stageSelectControl = page.locator(".ant-select").filter({
    has: stageSelect,
  });
  await stageSelectControl.click();
  const options = page.locator(".ant-select-dropdown:visible .ant-select-item-option");
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toHaveText("IFFO");
  await expect(options.nth(1)).toHaveText("GUM");
  await expect(page.getByText("新生儿阶段", { exact: true })).toHaveCount(0);
  await expect(page.getByText("二段阶段", { exact: true })).toHaveCount(0);
  await expect(page.getByText("成长阶段", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await stageSelectControl.click();
  await page
    .locator(".ant-select-dropdown:visible .ant-select-item-option")
    .filter({ hasText: /^IFFO$/u })
    .click();
  await expect(
    page.getByText(`当前规则集 · ${product.name} · IFFO`, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "要求阶段话题：#新生儿奶粉 / #二段奶粉推荐",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText("正文段位校验", { exact: true })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(/任一命中|任选其一/u);

  await stageSelectControl.click();
  await page
    .locator(".ant-select-dropdown:visible .ant-select-item-option")
    .filter({ hasText: /^GUM$/u })
    .click();
  await expect(
    page.getByText(`当前规则集 · ${product.name} · GUM`, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("要求阶段话题：#三段奶粉推荐", { exact: true }),
  ).toBeVisible();

  await stageSelectControl.click();
  await page
    .locator(".ant-select-dropdown:visible .ant-select-item-option")
    .filter({ hasText: /^IFFO$/u })
    .click();
  await expect(
    page.getByText(`当前规则集 · ${product.name} · IFFO`, { exact: true }),
  ).toBeVisible();

  const disableBodyStageResponse = await page.request.put(
    "/api/rule-stage-groups/IFFO_2",
    {
      data: {
        brandName: "达能",
        bodyTerms: ["2段"],
        requireBodyStage: false,
        requiredTopic: "#二段奶粉推荐",
      },
    },
  );
  expect(disableBodyStageResponse.ok()).toBeTruthy();

  const suffix = Date.now();
  const url = `${E2E_ORIGIN}/mock/xhs?case=aptamil-stage2-passed&stage-topic=${suffix}`;
  const createResponse = await page.request.post("/api/tasks", {
    data: {
      urls: url,
      productId: product.id,
      campaignId: campaign!.id,
      productStage: "IFFO",
      skipDuplicates: true,
    },
  });
  expect(createResponse.ok()).toBeTruthy();
  const task = (await createResponse.json()).data.created[0] as {
    id: string;
    productStage: string;
  };
  expect(task.productStage).toBe("IFFO");
  const ordinaryBody = "这是一次真实的小红书喂养体验记录".repeat(5);

  const auditResponse = await page.request.post(
    `/api/tasks/${task.id}/audit`,
    {
      data: {
        extraction: {
          url,
          finalUrl: url,
          pageTitle: "爱他美澳洲白金版2段真实体验",
          pageType: "NOTE_DETAIL",
          noteId: `stage-topic-body-${suffix}`,
          title: "爱他美澳洲白金版2段真实体验",
          body: `#爱他美新手爸妈日记#爱他美澳洲白金版#二段奶粉推荐#健康官方进口超市${ordinaryBody}`,
          noteType: "IMAGE_TEXT",
          imageExtractionStatus: "SUCCESS",
          imageCount: 2,
          topics: [
            "#爱他美新手爸妈日记",
            "#爱他美澳洲白金版",
            "#二段奶粉推荐",
            "#健康官方进口超市",
          ].map((displayText) => ({
            displayText,
            isLinkElement: false,
            hasHref: false,
            href: null,
            textColor: null,
            styleFeature: false,
            domPath: null,
            source: "BODY_VISIBLE_TEXT",
          })),
          pageStatus: "NORMAL",
          isPublic: true,
          extractedAt: new Date().toISOString(),
          adapterName: "playwright-xiaohongshu",
          adapterVersion: "1.4.0",
          technicalWarnings: ["TOPICS_NOT_RECOGNIZED"],
        },
      },
    },
  );
  expect(auditResponse.ok()).toBeTruthy();
  const result = (await auditResponse.json()).data as {
    id: string;
    autoStatus: string;
  };
  expect(result.autoStatus).toBe("PASSED");

  const detailResponse = await page.request.get(`/api/results/${result.id}`);
  expect(detailResponse.ok()).toBeTruthy();
  const detail = (await detailResponse.json()).data as {
    effectiveBodyLength: number;
    task: { productStage: string };
    failureReasons: string;
    missingTopics: string;
    ruleResults: Array<{
      ruleKey: string;
      ruleName: string;
      actualValue: string;
      passed: boolean;
    }>;
  };
  expect(detail.effectiveBodyLength).toBe(ordinaryBody.length);
  expect(detail.task.productStage).toBe("IFFO");
  expect(JSON.parse(detail.failureReasons)).not.toContain(
    "缺少精确话题 #新生儿奶粉",
  );
  expect(JSON.parse(detail.missingTopics)).toEqual([]);
  expect(
    detail.ruleResults.find((item) => item.ruleKey === "PRODUCT_STAGE_BODY"),
  ).toBeUndefined();
  expect(
    detail.ruleResults.find((item) => item.ruleKey === "GLOBAL_BODY"),
  ).toMatchObject({
    passed: true,
    actualValue: `${ordinaryBody.length} 个有效正文字符`,
  });
  expect(
    detail.ruleResults.find((item) =>
      item.ruleName.includes("产品阶段话题 IFFO"),
    ),
  ).toMatchObject({
    passed: true,
    actualValue: expect.stringContaining("#二段奶粉推荐"),
  });

  await page.goto("/results");
  const resultRow = page.locator(
    `.ant-table-row[data-row-key="${result.id}"]`,
  );
  await expect(resultRow).toContainText("IFFO");
  await expect(resultRow).toContainText("3 / 3");
  await expect(resultRow).not.toContainText("3 / 4");
  await expect(resultRow).not.toContainText("IFFO：P段/1段");
  await expect(resultRow).not.toContainText("IFFO：2段");

  await page.goto(`/results/${result.id}`);
  await expect(page).toHaveTitle("VERIDIA");
  const conclusionCard = page.getByRole("region", { name: "顶部结论" });
  await expect(conclusionCard.getByText("阶段", { exact: true })).toBeVisible();
  await expect(conclusionCard.getByText("IFFO", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("IFFO：P段/1段");
  await expect(page.locator("body")).not.toContainText("IFFO：2段");
  await expect(page.locator("body")).not.toContainText(
    "GUM：3段/4段/1+段/2+段",
  );
  await expect(page.getByText("正文段位校验", { exact: true })).toHaveCount(0);
  await expect(page.getByText("不参与审核", { exact: true })).toHaveCount(0);
  await expect(page.getByText("15天留存", { exact: true })).toHaveCount(0);
  await expect(page.getByText("作者", { exact: true })).toHaveCount(0);
  await expect(page.getByText("发布时间", { exact: true })).toHaveCount(0);
  await expect(page.getByText("留存计算", { exact: true })).toHaveCount(0);
  await expect(page.getByText("暂无结论", { exact: true })).toHaveCount(0);
  await expect(page.getByText("正文允许段位", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("本次使用的规则快照（内部技术字段）", { exact: true }),
  ).toHaveCount(0);
  const topicAuditCard = page
    .getByRole("heading", { name: "话题审核" })
    .locator("..");
  await expect(topicAuditCard).toContainText("3 / 3 合规");
  await expect(topicAuditCard).toContainText("已命中 #二段奶粉推荐");
  await expect(topicAuditCard).toContainText(
    "#新生儿奶粉 / #二段奶粉推荐",
  );
  await expect(page.getByText("阶段话题可点击", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("存在需要人工确认的审核项", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("技术读取失败不会生成内容不合规结论。", {
      exact: true,
    }),
  ).toHaveCount(0);

  await page.goto("/rules");
  await expect(page.getByRole("heading", { name: "话题规则" })).toBeVisible();
  const danoneBrandCard = page.locator(".ant-card").filter({
    has: page.getByText("达能", { exact: true }),
  });
  await expect(danoneBrandCard).toHaveCount(1);
  await danoneBrandCard.getByRole("button", { name: "进入规则" }).click();
  await expect(
    page.getByText(
      "产品阶段仅用于匹配对应话题，不要求正文出现段位词。标准话题会自动去空格并统一补充 #",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText("正文允许段位", { exact: true })).toHaveCount(0);
  const stageSummaryCard = page.locator(".ant-card").filter({
    has: page.getByText("产品阶段与要求话题", { exact: true }),
  });
  const stageSummaryRows = stageSummaryCard.locator(
    ".ant-table-tbody .ant-table-row",
  );
  await expect(stageSummaryRows).toHaveCount(2);
  const iffoSummaryRow = stageSummaryRows.filter({ hasText: "IFFO" });
  const gumSummaryRow = stageSummaryRows.filter({ hasText: "GUM" });
  await expect(iffoSummaryRow).toHaveCount(1);
  await expect(iffoSummaryRow).toContainText(
    "#新生儿奶粉 / #二段奶粉推荐",
  );
  await expect(gumSummaryRow).toHaveCount(1);
  await expect(gumSummaryRow).toContainText("#三段奶粉推荐");
  await expect(
    stageSummaryCard.getByText("正文段位校验", { exact: true }),
  ).toHaveCount(0);
  await expect(stageSummaryCard).not.toContainText("不校验，仅匹配话题");
  await expect(stageSummaryCard).not.toContainText(/任一命中|任选其一/u);
  const standardTopicTable = page.locator(".ant-table").filter({
    has: page.getByText("标准话题词", { exact: true }),
  });
  await expect(standardTopicTable).toContainText("#新生儿奶粉");
  await expect(standardTopicTable).toContainText("#二段奶粉推荐");
  await expect(standardTopicTable).toContainText("#三段奶粉推荐");
  await expect(page.locator("body")).not.toContainText("IFFO：P段/1段");
  await expect(page.locator("body")).not.toContainText("IFFO：2段");
  await expect(page.locator("body")).not.toContainText(
    "GUM：3段/4段/1+段/2+段",
  );
});

test("佳贝艾特活动过滤产品、隐藏阶段并允许无阶段创建任务", async ({
  page,
}) => {
  const loginResponse = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(loginResponse.ok()).toBeTruthy();

  const products = (await (await page.request.get("/api/products")).json())
    .data as Array<{ id: string; name: string; brandName: string }>;
  const campaigns = (await (await page.request.get("/api/campaigns")).json())
    .data as Array<{
      id: string;
      name: string;
      requiresProductStage: boolean;
    }>;
  const kabritaCampaign = campaigns.find(
    (item) => item.name === "佳贝艾特2026年8月小红书种草审核",
  )!;
  const danoneCampaign = campaigns.find((item) =>
    item.name.includes("爱他美2026年7月"),
  )!;
  const danoneProduct = products.find((item) =>
    item.name.includes("澳洲白金版"),
  )!;
  const kabritaProduct = products.find(
    (item) => item.name === "佳贝艾特荷兰版",
  )!;
  expect(kabritaCampaign.requiresProductStage).toBe(false);
  expect(danoneCampaign.requiresProductStage).toBe(true);

  await page.goto("/tasks");
  const activitySelect = page.getByRole("combobox", { name: "所属活动" });
  const productSelect = page.getByRole("combobox", { name: "所属产品" });
  const activitySelectControl = page.locator(".ant-select").filter({
    has: activitySelect,
  });
  await activitySelectControl.click();
  await page
    .locator(".ant-select-dropdown:visible .ant-select-item-option")
    .filter({ hasText: danoneCampaign.name })
    .click();
  await productSelect.click();
  await page
    .locator(".ant-select-dropdown:visible .ant-select-item-option")
    .filter({ hasText: danoneProduct.name })
    .click();
  await page.getByRole("combobox", { name: "产品阶段话题" }).click();
  await page
    .locator(".ant-select-dropdown:visible .ant-select-item-option")
    .filter({ hasText: /^IFFO$/u })
    .click();

  await activitySelectControl.click();
  await page
    .locator(".ant-select-dropdown:visible .ant-select-item-option")
    .filter({ hasText: kabritaCampaign.name })
    .click();
  await expect(
    page.getByRole("combobox", { name: "产品阶段话题" }),
  ).toHaveCount(0);
  await expect(page.getByText("请选择 IFFO 或 GUM。", { exact: true })).toHaveCount(0);

  const productSelectControl = page.locator(".ant-select").filter({
    has: productSelect,
  });
  await expect(productSelectControl).not.toContainText(danoneProduct.name);
  await productSelect.click();
  const kabritaOptions = page.locator(
    ".ant-select-dropdown:visible .ant-select-item-option",
  );
  await expect(kabritaOptions).toHaveCount(2);
  await expect(kabritaOptions.filter({ hasText: "爱他美" })).toHaveCount(0);
  await expect(kabritaOptions.filter({ hasText: "佳贝艾特荷兰版" })).toHaveCount(1);
  await expect(kabritaOptions.filter({ hasText: "佳贝艾特港版" })).toHaveCount(1);
  await kabritaOptions.filter({ hasText: kabritaProduct.name }).click();
  await expect(
    page.getByText(`当前规则集 · ${kabritaProduct.name}`, { exact: true }),
  ).toBeVisible();

  const uniqueUrl = `${E2E_ORIGIN}/mock/xhs?case=passed&kabrita-no-stage=${Date.now()}`;
  const createResponse = await page.request.post("/api/automation/batches", {
    data: {
      urls: uniqueUrl,
      productId: kabritaProduct.id,
      campaignId: kabritaCampaign.id,
      name: "佳贝艾特无阶段任务验证",
    },
  });
  const createPayload = await createResponse.json();
  expect(
    createResponse.ok(),
    `佳贝艾特无阶段任务创建失败：${JSON.stringify(createPayload)}`,
  ).toBeTruthy();
  expect(createPayload.data.created).toBe(1);

  const batchesResponse = await page.request.get(
    `/api/automation/batches?batchId=${createPayload.data.batchId}`,
  );
  const batch = (await batchesResponse.json()).data[0] as {
    productStage: string | null;
    tasks: Array<{ productStage: string | null }>;
  };
  expect(batch.productStage).toBeNull();
  expect(batch.tasks[0].productStage).toBeNull();
});
