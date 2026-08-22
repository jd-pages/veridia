import { expect, test } from "@playwright/test";
import { prisma } from "@/lib/db";
import {
  dismissRuleUpdateNoticeIfPresent,
  waitForRuleUpdateCheck,
} from "./helpers/rule-page";

test("话题规则先选择品牌并进入达能详情", async ({ page }) => {
  const login = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(login.ok()).toBeTruthy();

  const productsResponse = await page.request.get("/api/products");
  const products = (await productsResponse.json()).data as Array<{
    name: string;
    brandName: string;
  }>;
  expect(
    products
      .filter((product) => product.name.startsWith("爱他美"))
      .every((product) => product.brandName === "达能"),
  ).toBe(true);

  await page.goto("/rules");
  await expect(page.getByRole("heading", { name: "话题规则" })).toBeVisible();
  await expect(page.getByText("达能", { exact: true })).toBeVisible();
  await expect(page.getByText("#爱他美新手爸妈日记")).toHaveCount(0);

  const danoneBrandCard = page.locator(".rule-brand-card").filter({
    has: page.getByText("达能", { exact: true }),
  });
  const kabritaBrandCard = page.locator(".rule-brand-card").filter({
    has: page.getByText("佳贝艾特", { exact: true }),
  });
  await expect(danoneBrandCard).toHaveCount(1);
  await expect(kabritaBrandCard).toHaveCount(1);
  for (const productName of [
    "爱他美亲熠5HMO",
    "爱他美奇迹绿罐",
    "爱他美德国白金版",
    "爱他美澳洲白金版",
    "爱他美至熠",
  ]) {
    await expect(danoneBrandCard).toContainText(productName);
  }
  await expect(kabritaBrandCard).toContainText("佳贝艾特荷兰版");
  await expect(kabritaBrandCard).toContainText("佳贝艾特港版");
  await expect(page.getByText("展开", { exact: true })).toHaveCount(0);

  const [danoneBox, kabritaBox, danoneButtonBox, kabritaButtonBox] =
    await Promise.all([
      danoneBrandCard.boundingBox(),
      kabritaBrandCard.boundingBox(),
      danoneBrandCard.getByRole("button", { name: "进入规则" }).boundingBox(),
      kabritaBrandCard.getByRole("button", { name: "进入规则" }).boundingBox(),
    ]);
  expect(danoneBox).not.toBeNull();
  expect(kabritaBox).not.toBeNull();
  expect(danoneButtonBox).not.toBeNull();
  expect(kabritaButtonBox).not.toBeNull();
  expect(Math.abs(danoneBox!.width - kabritaBox!.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(danoneBox!.height - kabritaBox!.height)).toBeLessThanOrEqual(1);
  const danoneButtonBottomInset =
    danoneBox!.y + danoneBox!.height -
    (danoneButtonBox!.y + danoneButtonBox!.height);
  const kabritaButtonBottomInset =
    kabritaBox!.y + kabritaBox!.height -
    (kabritaButtonBox!.y + kabritaButtonBox!.height);
  expect(
    Math.abs(danoneButtonBottomInset - kabritaButtonBottomInset),
  ).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 390, height: 844 });
  const [
    mobileDanoneBox,
    mobileKabritaBox,
    mobileCardLayouts,
    hasHorizontalOverflow,
  ] = await Promise.all([
      danoneBrandCard.boundingBox(),
      kabritaBrandCard.boundingBox(),
      Promise.all(
        [danoneBrandCard, kabritaBrandCard].map((cardLocator) =>
          cardLocator.evaluate((card) => {
            const column = card.parentElement!;
            const columnStyle = window.getComputedStyle(column);
            return {
              flexBasis: columnStyle.flexBasis,
              maxWidth: columnStyle.maxWidth,
              cardWidth: window.getComputedStyle(card).width,
            };
          }),
        ),
      ),
      page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      ),
    ]);
  expect(mobileDanoneBox).not.toBeNull();
  expect(mobileKabritaBox).not.toBeNull();
  expect(
    Math.abs(mobileDanoneBox!.x - mobileKabritaBox!.x),
  ).toBeLessThanOrEqual(6);
  expect(mobileCardLayouts).toHaveLength(2);
  expect(
    mobileCardLayouts.every(
      (item) => item.flexBasis === "100%" && item.maxWidth === "100%",
    ),
  ).toBe(true);
  expect(mobileCardLayouts.every((item) => item.cardWidth !== "auto")).toBe(true);
  expect(hasHorizontalOverflow).toBe(false);

  await danoneBrandCard.getByRole("button", { name: "进入规则" }).click();
  await expect(
    page.getByRole("heading", { name: "达能话题规则" }),
  ).toBeVisible();
  await expect(page.getByText("#爱他美新手爸妈日记")).toBeVisible();
  await expect(
    page.getByText("产品阶段与要求话题", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTitle("2026年8月")).toBeVisible();
  await expect(page.getByText("IFFO 新生儿组（P段/1段）", { exact: true })).toBeVisible();
  await expect(page.getByText("IFFO 二段组（2段）", { exact: true })).toBeVisible();
  await expect(
    page.getByText("GUM 成长组（3段/4段/1+段/2+段）", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "返回品牌列表" })).toBeVisible();
});

test("佳贝艾特品牌、活动、产品和审核规则保持独立", async ({ page }) => {
  const login = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(login.ok()).toBeTruthy();

  const productsResponse = await page.request.get("/api/products");
  const products = (await productsResponse.json()).data as Array<{
    id: string;
    name: string;
    brandName: string;
    aliases: Array<{ alias: string }>;
  }>;
  const kabritaProducts = products.filter(
    (product) => product.brandName === "佳贝艾特",
  );
  expect(kabritaProducts.map((product) => product.name).sort()).toEqual([
    "佳贝艾特港版",
    "佳贝艾特荷兰版",
  ]);
  expect(
    kabritaProducts.find((product) => product.name === "佳贝艾特荷兰版")
      ?.aliases.map((item) => item.alias),
  ).toEqual(expect.arrayContaining(["荷兰版", "佳贝艾特荷兰", "Kabrita荷兰版"]));
  expect(
    kabritaProducts.find((product) => product.name === "佳贝艾特港版")
      ?.aliases.map((item) => item.alias),
  ).toEqual(expect.arrayContaining(["港版", "佳贝艾特港版", "Kabrita港版"]));

  const campaignsResponse = await page.request.get("/api/campaigns");
  const campaigns = (await campaignsResponse.json()).data as Array<{
    id: string;
    name: string;
    minBodyLength: number;
    minImageCount: number;
    requiresProductStage: boolean;
    products: Array<{ product: { id: string; brandName: string } }>;
  }>;
  const campaign = campaigns.find(
    (item) => item.name === "佳贝艾特2026年8月小红书种草审核",
  );
  expect(campaign).toMatchObject({
    minBodyLength: 50,
    minImageCount: 3,
    requiresProductStage: false,
  });
  expect(
    campaign?.products.every(({ product }) => product.brandName === "佳贝艾特"),
  ).toBe(true);

  const netherlandsProduct = kabritaProducts.find(
    (product) => product.name === "佳贝艾特荷兰版",
  )!;
  const requirementsResponse = await page.request.get(
    `/api/campaigns/${campaign!.id}/requirements?productId=${netherlandsProduct.id}`,
  );
  const requirementsPayload = await requirementsResponse.json();
  expect(
    requirementsResponse.ok(),
    `加载佳贝艾特审核要求失败：${JSON.stringify(requirementsPayload)}`,
  ).toBeTruthy();
  const requirements = requirementsPayload.data.context as {
    minBodyLength: number;
    minImageCount: number;
    requiresProductStage: boolean;
    rules: Array<{
      topic: string;
      ruleType: string;
      minCount: number;
      topicCategory: string;
    }>;
  };
  expect(requirements).toMatchObject({
    minBodyLength: 50,
    minImageCount: 3,
    requiresProductStage: false,
  });
  expect(requirements.rules.map((rule) => rule.topic)).toEqual(
    expect.arrayContaining([
      "#佳贝艾特荷兰版",
      "#初见小温柔成长更友好",
      "#羊奶粉推荐婴儿",
      "#好消化吸收的奶粉",
      "#不易敏敏",
      "#佳贝艾特羊奶粉",
    ]),
  );
  expect(
    requirements.rules.filter((rule) => rule.ruleType === "ANY"),
  ).toHaveLength(4);
  expect(
    requirements.rules
      .filter((rule) => rule.ruleType === "ANY")
      .every((rule) => rule.minCount === 2),
  ).toBe(true);
  expect(requirements.rules.map((rule) => rule.topic).join("、")).not.toMatch(
    /爱他美|新生儿奶粉|二段奶粉推荐|三段奶粉推荐/u,
  );

  const brandRulesResponse = await page.request.get(
    `/api/rules?brandName=${encodeURIComponent("佳贝艾特")}&month=2026-08&contentChannel=XIAOHONGSHU`,
  );
  const brandRules = (await brandRulesResponse.json()).data as Array<{
    status: string;
    topicCategory: string;
  }>;
  expect(
    brandRules
      .filter((rule) => rule.status === "ACTIVE")
      .reduce<Record<string, number>>((counts, rule) => {
        counts[rule.topicCategory] = (counts[rule.topicCategory] || 0) + 1;
        return counts;
      }, {}),
  ).toEqual({ BRAND_COMMON: 1, PRODUCT_COMMON: 2, POPULAR: 4 });

  const inactiveStageRule = await prisma.topicRule.create({
    data: {
      ruleSource: "LOCAL_DRAFT",
      scope: "CAMPAIGN",
      campaignId: campaign!.id,
      brandName: "佳贝艾特",
      contentChannel: "XIAOHONGSHU",
      ruleType: "MUST_ALL",
      topicCategory: "PRODUCT_STAGE",
      applicableStage: "IFFO_2",
      topic: "#初见小温柔成长更友好",
      status: "INACTIVE",
    },
  });
  try {
    const brandsResponse = await page.request.get(
      "/api/rule-brands?contentChannel=XIAOHONGSHU",
    );
    const brands = (await brandsResponse.json()).data as Array<{
      brandName: string;
      ruleCount: number;
    }>;
    expect(brands.find((brand) => brand.brandName === "佳贝艾特")?.ruleCount)
      .toBe(7);
  } finally {
    await prisma.topicRule.delete({ where: { id: inactiveStageRule.id } });
  }

  await page.goto("/rules");
  const kabritaBrandCard = page.locator(".ant-card").filter({
    has: page.getByText("佳贝艾特", { exact: true }),
  });
  await expect(kabritaBrandCard).toHaveCount(1);
  await expect(kabritaBrandCard).toContainText("2个");
  await expect(kabritaBrandCard).toContainText("7条");
  await kabritaBrandCard.getByRole("button", { name: "进入规则" }).click();
  await expect(
    page.getByRole("heading", { name: "佳贝艾特话题规则" }),
  ).toBeVisible();
  const breadcrumb = page.locator(".ant-breadcrumb");
  await expect(breadcrumb.getByText("笔记合规中心", { exact: true })).toBeVisible();
  await expect(breadcrumb.getByText("话题规则", { exact: true })).toBeVisible();
  await expect(breadcrumb.getByText("佳贝艾特", { exact: true })).toBeVisible();
  await expect(page.getByText("#佳贝艾特荷兰版", { exact: true })).toBeVisible();
  await expect(page.getByText("#佳贝艾特港版", { exact: true })).toBeVisible();
  await expect(
    page.getByText("产品阶段与要求话题", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("IFFO", { exact: true })).toHaveCount(0);
  await expect(page.getByText("GUM", { exact: true })).toHaveCount(0);
  const standardTopicTable = page.locator(".ant-table").filter({
    has: page.getByText("标准话题词", { exact: true }),
  });
  await expect(standardTopicTable.locator(".ant-table-tbody .ant-table-row")).toHaveCount(7);
  for (const topic of [
    "#初见小温柔成长更友好",
    "#佳贝艾特荷兰版",
    "#佳贝艾特港版",
    "#羊奶粉推荐婴儿",
    "#好消化吸收的奶粉",
    "#不易敏敏",
    "#佳贝艾特羊奶粉",
  ]) {
    await expect(standardTopicTable.getByText(topic, { exact: true })).toBeVisible();
  }
  await expect(page.getByText("#爱他美新手爸妈日记")).toHaveCount(0);

  await page.goto("/campaigns");
  const campaignRow = page.locator(".ant-table-row").filter({
    has: page.getByText("佳贝艾特2026年8月小红书种草审核", {
      exact: true,
    }),
  });
  await campaignRow.getByRole("button", { name: "查看规则" }).click();
  const detailDrawer = page.locator(".ant-drawer-content");
  await expect(detailDrawer).toContainText("佳贝艾特荷兰版");
  await expect(detailDrawer).toContainText("佳贝艾特港版");
  await expect(detailDrawer).toContainText("至少 50 个有效正文字符");
  await expect(detailDrawer).toContainText("图文笔记至少 3 张");
  await expect(detailDrawer.getByText("至少 2 个", { exact: true })).toHaveCount(4);
});

test("达能月度规则支持空月份、复制创建、独立主键和刷新保持", async ({
  page,
}) => {
  const loginResponse = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(loginResponse.ok()).toBeTruthy();

  const ruleUpdateCheck = waitForRuleUpdateCheck(page);
  await page.goto("/rules?brand=%E8%BE%BE%E8%83%BD&month=2026-09");
  await expect(
    page.getByRole("heading", { name: "达能话题规则" }),
  ).toBeVisible();
  await expect(page.getByTitle("2026年9月")).toBeVisible();
  await expect(
    page.getByText("当前月份暂无规则", { exact: true }),
  ).toBeVisible();

  await dismissRuleUpdateNoticeIfPresent(page, await ruleUpdateCheck);
  const createMonthButton = page.getByRole("button", { name: "新增月份规则" });
  await createMonthButton.scrollIntoViewIfNeeded();
  await expect(createMonthButton).toBeVisible();
  await expect(createMonthButton).toBeEnabled();
  await createMonthButton.click();
  const monthModal = page.getByRole("dialog", { name: "新增月份规则" });
  await monthModal.getByLabel("规则月份").fill("2026-09");
  const copySwitch = monthModal.locator(".ant-switch");
  await expect(copySwitch).toHaveAttribute("aria-checked", "true");
  await monthModal
    .locator(".ant-form-item")
    .filter({ hasText: "复制来源月份" })
    .locator(".ant-select")
    .click();
  await page
    .locator(".ant-select-dropdown:visible .ant-select-item-option")
    .filter({ hasText: "2026年8月" })
    .click();
  await page.locator(".ant-modal:visible .ant-modal-footer .ant-btn-primary").click();

  await expect(page).toHaveURL(/brand=.*month=2026-09/u);
  await expect(page.getByTitle("2026年9月")).toBeVisible();
  await expect(page.getByText("当前月份暂无规则", { exact: true })).toHaveCount(0);
  const septemberRules = (await (
    await page.request.get("/api/rules?brandName=%E8%BE%BE%E8%83%BD&month=2026-09")
  ).json()).data as Array<{ id: string }>;
  const augustRules = (await (
    await page.request.get("/api/rules?brandName=%E8%BE%BE%E8%83%BD&month=2026-08")
  ).json()).data as Array<{ id: string }>;
  expect(septemberRules).toHaveLength(9);
  expect(new Set(septemberRules.map((rule) => rule.id))).not.toEqual(
    new Set(augustRules.map((rule) => rule.id)),
  );

  await page.reload();
  await expect(page.getByTitle("2026年9月")).toBeVisible();
  await expect(
    page.getByText("IFFO 新生儿组（P段/1段）", { exact: true }),
  ).toBeVisible();

  const sourceCampaigns = (await (
    await page.request.get("/api/campaigns")
  ).json()).data as Array<{ id: string; month: string; name: string }>;
  const augustCampaign = sourceCampaigns.find(
    (campaign) =>
      campaign.month === "2026-08" && campaign.name.startsWith("爱他美"),
  );
  expect(augustCampaign).toBeTruthy();
  const duplicateResponse = await page.request.post(
    `/api/campaigns/${augustCampaign!.id}/copy`,
    { data: { month: "2026-09" } },
  );
  expect(duplicateResponse.status()).toBe(409);
  await expect(duplicateResponse.json()).resolves.toMatchObject({
    error: "达能2026-09 规则已存在。",
  });
});
