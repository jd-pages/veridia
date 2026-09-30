import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import {
  dismissRuleUpdateNoticeIfPresent,
  waitForRuleUpdateCheck,
} from "./helpers/rule-page";

function isolatedDatabase() {
  const datasourceUrl = process.env.E2E_DATABASE_URL?.trim();
  if (!datasourceUrl) throw new Error("活动产品关联验收只能使用隔离 E2E 数据库");
  return new PrismaClient({ datasourceUrl });
}

async function openProductRules(page: Page, brandName: string, productName: string) {
  const check = waitForRuleUpdateCheck(page);
  await page.goto(`/rules?brand=${encodeURIComponent(brandName)}&month=2026-10&channel=XIAOHONGSHU`);
  await dismissRuleUpdateNoticeIfPresent(page, await check);
  await expect(page.getByRole("heading", { name: `${brandName}话题规则` })).toBeVisible();
  await page.locator(".ant-segmented").getByText("产品规则", { exact: true }).click();
  const card = page.locator(".rule-product-card").filter({ has: page.getByText(productName, { exact: true }) });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "进入产品规则" }).click();
  await page.getByRole("button", { name: "新增产品规则" }).click();
  return page.getByRole("dialog", { name: "新增产品规则" });
}

test("Protected PRODUCT_RULE_CAN_JOIN_EXISTING_CAMPAIGN：新建佳贝艾特产品通过规则加入10月活动并被Import识别", async ({ page }) => {
  test.setTimeout(90_000);
  expect((await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  })).status()).toBe(200);
  const db = isolatedDatabase();
  const suffix = randomUUID();
  const name = `晴湛儿童粉 E2E ${suffix}`;
  const primary = await db.product.create({ data: { name: `佳贝艾特既有产品${suffix}`, brandName: "佳贝艾特" } });
  const campaign = await db.campaign.create({ data: {
    name: `佳贝艾特2026年10月活动${suffix}`, month: "2026-10", year: 2026,
    contentChannel: "XIAOHONGSHU", productId: primary.id,
    startDate: new Date("2026-10-01T00:00:00.000Z"),
    endDate: new Date("2026-10-31T23:59:59.000Z"),
    products: { create: [{ productId: primary.id }] },
    rewardMode: "CONTENT_BASE_PLUS_INTERACTION_TIERS", basicRewardRequired: true, baseRewardAmount: 50,
    interactionRewardTiers: { create: [{ threshold: 10, amount: 20, sortOrder: 0 }, { threshold: 40, amount: 50, sortOrder: 1 }] },
  } });
  let productId = "";
  let releaseRefresh: (() => void) | undefined;
  try {
    await page.goto("/products");
    await page.getByRole("button", { name: "新增产品" }).click();
    const productDialog = page.getByRole("dialog", { name: "新增产品" });
    await productDialog.getByLabel("产品名称", { exact: true }).fill(name);
    await productDialog.getByLabel("品牌名称", { exact: true }).fill("佳贝艾特");
    const productResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/products" && response.request().method() === "POST");
    await productDialog.getByRole("button", { name: /^保\s*存$/ }).click();
    const createdProduct = await productResponse;
    expect(createdProduct.status()).toBe(201);
    productId = (await createdProduct.json()).data.id;
    await expect(productDialog).not.toBeVisible();
    expect(await db.campaignProduct.count({ where: { campaignId: campaign.id, productId } })).toBe(0);

    const dialog = await openProductRules(page, "佳贝艾特", name);
    await expect(dialog).toContainText("保存规则时会同时加入该活动");
    await dialog.getByLabel("所属活动", { exact: true }).press("ArrowDown");
    const option = page.locator(".ant-select-item-option").filter({
      hasText: `${campaign.name}【保存后加入活动】`,
    });
    await expect(option).toBeVisible();
    await expect(page.locator(".ant-select-dropdown:visible")).not.toContainText("达能");
    await expect(page.locator(".ant-select-dropdown:visible")).not.toContainText("惠氏");
    await expect(page.locator(".ant-select-dropdown:visible")).not.toContainText("雀巢");
    await option.click();
    const topic = `#晴湛儿童粉关联${suffix}`;
    await dialog.getByLabel("标准话题词", { exact: true }).fill(topic);

    let refreshStarted!: () => void;
    const refreshStart = new Promise<void>((resolve) => { refreshStarted = resolve; });
    const refreshHold = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const campaignRoute = "**/api/campaigns?contentChannel=XIAOHONGSHU";
    await page.route(campaignRoute, async (route) => {
      const response = await route.fetch();
      refreshStarted();
      await refreshHold;
      await route.fulfill({ response });
    });
    const saved = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/rules" && response.request().method() === "POST");
    await dialog.getByRole("button", { name: /^保\s*存$/ }).click();
    expect((await saved).status()).toBe(201);
    await refreshStart;
    await expect(dialog).toBeVisible();
    expect(await db.campaignProduct.count({ where: { campaignId: campaign.id, productId } })).toBe(1);
    releaseRefresh?.();
    await expect(dialog).not.toBeVisible();
    await page.unroute(campaignRoute);
    expect(await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } }))
      .toMatchObject({ productId: primary.id, ruleVersion: campaign.ruleVersion + 1 });
    expect(await db.topicRule.count({ where: { productId, campaignId: campaign.id, scope: "PRODUCT" } })).toBe(1);

    await page.getByRole("button", { name: "新增产品规则" }).click();
    const reopened = page.getByRole("dialog", { name: "新增产品规则" });
    await reopened.getByLabel("所属活动", { exact: true }).press("ArrowDown");
    await expect(page.locator(".ant-select-item-option").filter({
      hasText: `${campaign.name}【已加入活动】`,
    })).toBeVisible();
    await reopened.getByLabel("所属活动", { exact: true }).press("Escape");
    await reopened.getByRole("button", { name: /^取\s*消$/ }).click();
    await page.getByRole("button", { name: "返回产品列表" }).click();
    await expect(page.locator(".rule-product-card").filter({ has: page.getByText(name, { exact: true }) }))
      .toContainText("活动 1 个");

    const filteredCampaigns = await page.request.get(`/api/campaigns?productId=${productId}&month=2026-10&contentChannel=XIAOHONGSHU`);
    expect((await filteredCampaigns.json()).data.map((item: { id: string }) => item.id)).toContain(campaign.id);
    const rules = await page.request.get(`/api/rules?brandName=${encodeURIComponent("佳贝艾特")}&month=2026-10&contentChannel=XIAOHONGSHU`);
    expect((await rules.json()).data.find((rule: { topic: string }) => rule.topic === topic))
      .toMatchObject({ productId, campaignId: campaign.id, bindingStatus: "VALID" });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("佳贝艾特导入");
    sheet.addRow([
      "登记时间", "渠道", "店铺名称", "客户备注", "买家购买ID", "购买订单号",
      "购买时间", "购买罐数", "参与次数", "发布小红书账号", "小红书发布链接",
      "购买产品线", "活动月份（必填）", "是否符合",
    ]);
    sheet.addRow([
      "2026-10-03 12:00:00", "京东", "佳贝艾特(Kabrita)海外专卖店", "",
      `BUYER-${suffix}`, `ORDER-${suffix}`, "2026-10-02", "1", "1", "晴湛测试账号",
      `https://xhslink.com/o/membership-${suffix}`, name, "2026-10", "",
    ]);
    const preview = await page.request.post("/api/import/notes", { multipart: {
      file: { name: `membership-${suffix}.xlsx`,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: Buffer.from(await workbook.xlsx.writeBuffer()) },
      commit: "false", skipDuplicates: "true",
    } });
    expect(preview.ok()).toBeTruthy();
    const preflight = (await preview.json()).data;
    expect(preflight.rows[0]).toMatchObject({
      productId, campaignId: campaign.id, campaignMatchStatus: "MATCHED",
    });
    expect(preflight.rows[0].campaignRuleCount).toBeGreaterThan(0);
    console.info(`[PRODUCT_RULE_CAMPAIGN_MEMBERSHIP] ${JSON.stringify({
      newProductIdFixture: productId, campaignIdFixture: campaign.id,
      membershipBefore: 0, membershipCreated: true, membershipDuplicateCount: 0,
      topicRuleCreated: true, refreshBeforeModalClose: true, importPreflightAfterMembership: preflight.rows[0].campaignMatchStatus,
    })}`);
  } finally {
    releaseRefresh?.();
    const rules = await db.topicRule.findMany({ where: { campaignId: campaign.id }, select: { id: true } });
    await db.operationLog.deleteMany({ where: { entityId: { in: [campaign.id, primary.id, productId, ...rules.map(({ id }) => id)] } } });
    await db.topicRule.deleteMany({ where: { campaignId: campaign.id } });
    await db.campaign.delete({ where: { id: campaign.id } });
    await db.product.deleteMany({ where: { id: { in: [primary.id, productId] } } });
    await db.$disconnect();
  }
});

test("单一候选自动选中，多个同月活动要求明确选择并排除跨品牌月份平台及已删除活动", async ({ page }) => {
  expect((await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  })).status()).toBe(200);
  const db = isolatedDatabase();
  const suffix = randomUUID();
  const brandName = `关联候选品牌${suffix}`;
  const primary = await db.product.create({ data: { name: `候选原产品${suffix}`, brandName } });
  const product = await db.product.create({ data: { name: `候选新产品${suffix}`, brandName } });
  const foreign = await db.product.create({ data: { name: `跨品牌产品${suffix}`, brandName: `其他${brandName}` } });
  const ids: string[] = [];
  const campaign = async (label: string, overrides = {}) => {
    const result = await db.campaign.create({ data: {
      name: `${label}${suffix}`, month: "2026-10", contentChannel: "XIAOHONGSHU", productId: primary.id,
      startDate: new Date("2026-10-01T00:00:00.000Z"), endDate: new Date("2026-10-31T23:59:59.000Z"),
      ...overrides,
    } });
    ids.push(result.id);
    return result;
  };
  try {
    const single = await campaign("唯一活动");
    const excluded = await Promise.all([
      campaign("跨品牌活动", { productId: foreign.id }),
      campaign("跨月份活动", { month: "2026-09" }),
      campaign("跨平台活动", { contentChannel: "DOUYIN" }),
      campaign("已删除活动", { deletedAt: new Date() }),
    ]);
    const dialog = await openProductRules(page, brandName, product.name);
    await expect(dialog.locator(".ant-select-selection-item").filter({ hasText: single.name }))
      .toContainText("保存后加入活动");
    await dialog.getByRole("button", { name: /^取\s*消$/ }).click();
    const second = await campaign("第二活动");
    const multiple = await openProductRules(page, brandName, product.name);
    const campaignField = multiple.locator(".ant-form-item").filter({ has: page.getByText("所属活动", { exact: true }) });
    await expect(campaignField).toHaveCount(1);
    await expect(campaignField.locator(".ant-select-selection-item")).toHaveCount(0);
    await multiple.getByLabel("所属活动", { exact: true }).press("ArrowDown");
    const dropdown = page.locator(".ant-select-dropdown:visible");
    await expect(dropdown).toContainText(single.name);
    await expect(dropdown).toContainText(second.name);
    for (const item of excluded) await expect(dropdown).not.toContainText(item.name);
    expect(await db.campaignProduct.count({ where: { productId: product.id } })).toBe(0);
  } finally {
    await db.campaign.deleteMany({ where: { id: { in: ids } } });
    await db.product.deleteMany({ where: { id: { in: [primary.id, product.id, foreign.id] } } });
    await db.$disconnect();
  }
});
