import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { removeTemporaryDirectoryWithRetry } from "@/tests/helpers/remove-temporary-directory";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(), transaction: vi.fn(), database: undefined as PrismaClient | undefined,
}));
vi.mock("@/lib/auth", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, {
  get: (_target, property) => property === "$transaction"
    ? mocks.transaction
    : mocks.database && Reflect.get(mocks.database, property),
}) }));

import { POST } from "@/app/api/rules/route";
import { PUT } from "@/app/api/rules/[id]/route";
import { POST as createTasks } from "@/app/api/tasks/route";
import { getAuditContext } from "@/lib/audit-service";
import { rewardFromResultSnapshot } from "@/lib/interaction-reward";
import { ensureCampaignProductMembership } from "@/lib/campaign-product-membership";
import {
  createTopicRuleInTransaction,
  updateTopicRuleInTransaction,
} from "@/lib/topic-rule-management";
import {
  campaignContainsProduct,
  effectiveTopicRulesForContext,
} from "@/lib/topic-rule-model";
import { resolveImportedActivityMonth } from "@/lib/import-activity-matching";

let temporaryRoot = "";
let db: PrismaClient;
let userId = "";

beforeAll(async () => {
  const root = process.cwd();
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veridia-membership-"));
  execFileSync(process.execPath, [path.join(root, "scripts/testing/e2e-database-template.mjs")], {
    cwd: root, env: process.env, stdio: "pipe", windowsHide: true,
  });
  const databasePath = path.join(temporaryRoot, "membership.db");
  fs.copyFileSync(path.join(root, ".playwright/e2e-template/baseline.db"), databasePath);
  fs.chmodSync(databasePath, 0o600);
  db = new PrismaClient({ datasourceUrl: `file:${databasePath.replaceAll("\\", "/")}` });
  mocks.database = db;
  userId = (await db.user.findFirstOrThrow({ where: { role: "ADMIN" } })).id;
  mocks.getSession.mockResolvedValue({ id: userId, role: "ADMIN" });
  mocks.transaction.mockImplementation((callback) => db.$transaction(callback));
}, 30_000);

afterAll(async () => {
  await db?.$disconnect();
  if (temporaryRoot) await removeTemporaryDirectoryWithRetry(temporaryRoot);
}, 30_000);

async function fixture(brandName = "佳贝艾特") {
  const suffix = randomUUID();
  const primary = await db.product.create({
    data: { name: `既有产品-${suffix}`, brandName },
  });
  const product = await db.product.create({
    data: { name: `晴湛儿童粉-${suffix}`, brandName },
  });
  const campaign = await db.campaign.create({
    data: {
      name: `${brandName}2026年10月活动-${suffix}`,
      productId: primary.id,
      month: "2026-10",
      year: 2026,
      contentChannel: "XIAOHONGSHU",
      startDate: new Date("2026-10-01T00:00:00.000Z"),
      endDate: new Date("2026-10-31T23:59:59.000Z"),
      ruleVersion: 5,
      ...(brandName === "佳贝艾特" ? {
        rewardMode: "CONTENT_BASE_PLUS_INTERACTION_TIERS",
        basicRewardRequired: true,
        baseRewardAmount: 50,
        interactionRewardTiers: { create: [
          { threshold: 10, amount: 20, sortOrder: 0 },
          { threshold: 40, amount: 50, sortOrder: 1 },
        ] },
      } : {}),
      products: { create: [{ productId: primary.id }] },
    },
  });
  return { suffix, brandName, primary, product, campaign };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function ruleBody(value: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    scope: "PRODUCT",
    brandName: value.brandName,
    productId: value.product.id,
    campaignId: value.campaign.id,
    selectedMonth: "2026-10",
    contentChannel: "XIAOHONGSHU",
    ruleType: "MUST_ALL",
    topic: `#晴湛儿童粉${value.suffix}`,
    ...overrides,
  };
}

async function create(value: Fixture, overrides: Record<string, unknown> = {}) {
  return db.$transaction((tx) => createTopicRuleInTransaction(tx, {
    userId, body: ruleBody(value, overrides),
  }));
}

function post(body: Record<string, unknown>) {
  return POST(new Request("http://localhost/api/rules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

async function state(value: Fixture) {
  return {
    memberships: await db.campaignProduct.findMany({
      where: { campaignId: value.campaign.id }, orderBy: { id: "asc" },
    }),
    rules: await db.topicRule.findMany({
      where: { campaignId: value.campaign.id }, orderBy: { id: "asc" },
    }),
    campaign: await db.campaign.findUniqueOrThrow({
      where: { id: value.campaign.id },
    }),
    logs: await db.operationLog.count(),
  };
}

describe.sequential("PRODUCT_RULE_CAN_JOIN_EXISTING_CAMPAIGN", () => {
  it("新产品与规则、版本、日志一起保存，并保留 legacy 主产品", async () => {
    const value = await fixture();
    const before = await state(value);
    expect(campaignContainsProduct({ ...value.campaign, products: [] }, value.product.id)).toBe(false);
    const response = await post(ruleBody(value));
    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload).toMatchObject({ success: true, data: {
      scope: "PRODUCT", productId: value.product.id, campaignId: value.campaign.id,
      brandName: "佳贝艾特", contentChannel: "XIAOHONGSHU", version: 6,
    } });
    const campaign = await db.campaign.findUniqueOrThrow({
      where: { id: value.campaign.id }, include: { products: true },
    });
    expect(campaignContainsProduct(campaign, value.product.id)).toBe(true);
    expect(campaign).toMatchObject({ productId: value.primary.id, ruleVersion: 6 });
    expect(await db.campaignProduct.count({
      where: { campaignId: campaign.id, productId: value.product.id },
    })).toBe(1);
    expect(await db.topicRule.count({ where: { campaignId: campaign.id } })).toBe(1);
    expect(await db.operationLog.count()).toBe(before.logs + 1);
    expect(await db.operationLog.findFirstOrThrow({ where: { entityId: payload.data.id } }))
      .toMatchObject({ action: "CREATE_RULE", entityType: "TOPIC_RULE" });
    expect(await db.product.findUniqueOrThrow({ where: { id: value.product.id } })).toEqual(value.product);
  });

  it("重复 helper 与不同产品规则保存不会重复 membership", async () => {
    const value = await fixture();
    await create(value);
    const membership = await db.campaignProduct.findUniqueOrThrow({
      where: { campaignId_productId: { campaignId: value.campaign.id, productId: value.product.id } },
    });
    await db.$transaction((tx) => ensureCampaignProductMembership(tx, {
      campaignId: value.campaign.id, productId: value.product.id,
      brandName: value.brandName, selectedMonth: "2026-10", contentChannel: "XIAOHONGSHU",
    }));
    await create(value, { topic: `#第二条规则${value.suffix}` });
    expect(await db.campaignProduct.findMany({
      where: { campaignId: value.campaign.id, productId: value.product.id },
    })).toEqual([membership]);
    expect(await db.topicRule.count({ where: { productId: value.product.id } })).toBe(2);
    const beforeDuplicate = await state(value);
    expect((await post(ruleBody(value))).status).toBe(409);
    expect(await state(value)).toEqual(beforeDuplicate);
  });

  it("可复用 helper 独立校验品牌、月份和平台且拒绝时零写入", async () => {
    const value = await fixture();
    const before = await state(value);
    for (const overrides of [{ brandName: "达能" }, { selectedMonth: "2026-09" }, { contentChannel: "DOUYIN" }]) {
      await expect(db.$transaction((tx) => ensureCampaignProductMembership(tx, {
        campaignId: value.campaign.id, productId: value.product.id,
        brandName: value.brandName, selectedMonth: "2026-10", contentChannel: "XIAOHONGSHU", ...overrides,
      }))).rejects.toThrow();
      expect(await state(value)).toEqual(before);
    }
  });

  it.each([
    { label: "跨品牌", overrides: { brandName: "达能" }, message: "所选产品不属于当前品牌" },
    { label: "跨月份", overrides: { selectedMonth: "2026-09" }, message: "所属活动与当前规则月份不一致" },
    { label: "跨平台", overrides: { contentChannel: "DOUYIN" }, message: "规则内容平台与所属活动不一致" },
    { label: "缺失月份", overrides: { selectedMonth: undefined }, message: "产品规则必须提供当前规则月份" },
  ])("$label请求返回400且零写入", async ({ overrides, message }) => {
    const value = await fixture();
    const before = await state(value);
    const response = await post(ruleBody(value, overrides));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, error: message });
    expect(await state(value)).toEqual(before);
  });

  it("产品不能加入另一品牌活动或混合品牌 legacy 活动", async () => {
    const value = await fixture();
    const foreignProduct = await db.product.create({ data: { name: `达能-${value.suffix}`, brandName: "达能" } });
    await db.campaign.update({ where: { id: value.campaign.id }, data: { productId: foreignProduct.id } });
    const before = await state(value);
    const response = await post(ruleBody(value));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "所选产品与活动品牌不一致" });
    expect(await state(value)).toEqual(before);
    await db.campaignProduct.deleteMany({ where: { campaignId: value.campaign.id } });
    const foreignOnly = await state(value);
    expect((await post(ruleBody(value))).status).toBe(400);
    expect(await state(value)).toEqual(foreignOnly);
  });

  it("已删除产品或活动拒绝加入", async () => {
    for (const target of ["product", "campaign"] as const) {
      const value = await fixture();
      if (target === "product") {
        await db.product.update({ where: { id: value.product.id }, data: { deletedAt: new Date() } });
      } else {
        await db.campaign.update({ where: { id: value.campaign.id }, data: { deletedAt: new Date() } });
      }
      const before = await state(value);
      expect((await post(ruleBody(value))).status).toBe(400);
      expect(await state(value)).toEqual(before);
    }
  });

  it("重复规则返回409，新产品未被偷偷加入活动", async () => {
    const value = await fixture();
    await db.topicRule.create({ data: {
      scope: "PRODUCT", productId: value.product.id, campaignId: value.campaign.id,
      brandName: value.brandName, contentChannel: "XIAOHONGSHU", ruleType: "MUST_ALL",
      topic: ruleBody(value).topic,
    } });
    const before = await state(value);
    const response = await post(ruleBody(value));
    expect(response.status).toBe(409);
    expect(await state(value)).toEqual(before);
    expect(await db.campaignProduct.count({
      where: { campaignId: value.campaign.id, productId: value.product.id },
    })).toBe(0);
  });

  it.each([
    ["campaign_products", "MEMBERSHIP_FAILURE"],
    ["topic_rules", "TOPIC_RULE_FAILURE"],
    ["operation_logs", "OPERATION_LOG_FAILURE"],
  ])("%s写入失败使 membership、规则、版本与日志全部回滚", async (table, fault) => {
    const value = await fixture();
    const before = await state(value);
    const trigger = `membership_test_${table}`;
    await db.$executeRawUnsafe(`CREATE TRIGGER "${trigger}" BEFORE INSERT ON "${table}" BEGIN SELECT RAISE(ABORT, '${fault}'); END`);
    try {
      await expect(create(value)).rejects.toThrow();
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER "${trigger}"`);
    }
    expect(await state(value)).toEqual(before);
  });

  it("编辑转到未关联活动时建立新 join，旧 join 保留且两个活动版本各加一", async () => {
    const value = await fixture();
    const rule = await create(value);
    const target = await fixture();
    const response = await PUT(new Request(`http://localhost/api/rules/${rule.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brandName: value.brandName, campaignId: target.campaign.id, selectedMonth: "2026-10" }),
    }), { params: Promise.resolve({ id: rule.id }) });
    expect(response.status).toBe(200);
    expect(await db.campaignProduct.count({ where: {
      campaignId: { in: [value.campaign.id, target.campaign.id] }, productId: value.product.id,
    } })).toBe(2);
    expect(await db.campaign.findUniqueOrThrow({ where: { id: value.campaign.id } }))
      .toMatchObject({ productId: value.primary.id, ruleVersion: 7 });
    expect(await db.campaign.findUniqueOrThrow({ where: { id: target.campaign.id } }))
      .toMatchObject({ productId: target.primary.id, ruleVersion: 6 });
    expect(await db.topicRule.findUniqueOrThrow({ where: { id: rule.id } }))
      .toMatchObject({ productId: value.product.id, campaignId: target.campaign.id, version: 6 });
  });

  it("编辑过程中日志失败也撤销新活动关联，保留旧规则与旧关联", async () => {
    const value = await fixture();
    const rule = await create(value);
    const target = await fixture();
    const before = [await state(value), await state(target)];
    await db.$executeRawUnsafe("CREATE TRIGGER membership_edit_log_failure BEFORE INSERT ON operation_logs BEGIN SELECT RAISE(ABORT, 'EDIT_LOG_FAILURE'); END");
    try {
      await expect(db.$transaction((tx) => updateTopicRuleInTransaction(tx, {
        id: rule.id, userId, expectedBrandName: value.brandName,
        body: { campaignId: target.campaign.id, selectedMonth: "2026-10" },
      }))).rejects.toThrow();
    } finally {
      await db.$executeRawUnsafe("DROP TRIGGER membership_edit_log_failure");
    }
    expect([await state(value), await state(target)]).toEqual(before);
  });

  it("新成员正常继承通用和活动规则，只使用自己的PRODUCT规则并被导入月份匹配识别", async () => {
    const value = await fixture();
    const globalTopic = `#通用${value.suffix}`;
    const campaignTopic = `#活动${value.suffix}`;
    const otherProductTopic = `#其他产品${value.suffix}`;
    await db.topicRule.createMany({ data: [
      { scope: "GLOBAL", brandName: value.brandName, ruleType: "MUST_ALL", topic: globalTopic },
      { scope: "CAMPAIGN", brandName: value.brandName, campaignId: value.campaign.id, ruleType: "MUST_ALL", topic: campaignTopic },
      { scope: "PRODUCT", brandName: value.brandName, campaignId: value.campaign.id, productId: value.primary.id, ruleType: "MUST_ALL", topic: otherProductTopic },
    ] });
    const countBefore = await db.topicRule.count({ where: { campaignId: value.campaign.id } });
    const created = await create(value);
    const campaign = await db.campaign.findUniqueOrThrow({
      where: { id: value.campaign.id }, include: { product: true, products: { include: { product: true } } },
    });
    const rules = await db.topicRule.findMany({ where: { brandName: value.brandName }, include: {
      product: true, campaign: { include: { product: true, products: { include: { product: true } } } },
    } });
    const effective = effectiveTopicRulesForContext(rules, {
      brandName: value.brandName, productId: value.product.id,
      campaignId: campaign.id, contentChannel: "XIAOHONGSHU",
    });
    expect(effective.map(({ topic }) => topic)).toEqual(expect.arrayContaining([globalTopic, campaignTopic, created.topic]));
    expect(effective.map(({ topic }) => topic)).not.toContain(otherProductTopic);
    expect(await db.topicRule.count({ where: { campaignId: campaign.id } })).toBe(countBefore + 1);
    expect(resolveImportedActivityMonth({
      activityMonth: "2026-10", expectedBrand: value.brandName,
      productId: value.product.id, contentChannel: "XIAOHONGSHU",
      candidates: [{ ...campaign, productIds: campaign.products.map(({ productId }) => productId),
        brandNames: [value.brandName], ruleCount: effective.length }],
    })).toMatchObject({ status: "MATCHED", campaign: { id: campaign.id } });
    const taskResponse = await createTasks(new Request("http://localhost/api/tasks", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId: value.product.id, campaignId: campaign.id,
        productStage: "IFFO", contentChannel: "XIAOHONGSHU",
        urls: `https://www.xiaohongshu.com/explore/${value.suffix.replaceAll("-", "").slice(0, 24)}` }),
    }));
    expect(taskResponse.status).toBe(200);
    expect(await taskResponse.json()).toMatchObject({ success: true, data: {
      created: [{ productId: value.product.id, campaignId: campaign.id }], errors: [],
    } });
    const context = await getAuditContext(value.product.id, campaign.id, "IFFO", "XIAOHONGSHU");
    expect(context).toMatchObject({ rewardMode: "CONTENT_BASE_PLUS_INTERACTION_TIERS",
      baseRewardAmount: 50, interactionRewardTiers: [{ threshold: 10, amount: 20 }, { threshold: 40, amount: 50 }] });
    expect(context.rules.map(({ topic }) => topic)).toContain(created.topic);
    expect(context.rules.map(({ topic }) => topic)).not.toContain(otherProductTopic);
    for (const [total, extra] of [[0, 0], [10, 20], [40, 50]]) {
      expect(rewardFromResultSnapshot({ ruleSnapshot: JSON.stringify(context),
        finalContentStatus: "PASSED", autoStatus: "PASSED", pageStatus: "NORMAL",
        likeCount: total, commentCount: 0, favoriteCount: 0,
      })).toMatchObject({ baseRewardAmount: 50, extraRewardAmount: extra });
    }
    expect(rewardFromResultSnapshot({ ruleSnapshot: JSON.stringify(context),
      finalContentStatus: "FAILED", autoStatus: "FAILED", pageStatus: "NORMAL",
      likeCount: 40, commentCount: 0, favoriteCount: 0,
    })).toMatchObject({ baseRewardAmount: 0, extraRewardAmount: 0 });
    expect(await db.product.findUniqueOrThrow({ where: { id: value.product.id } })).toEqual(value.product);
  });

  it.each(["达能", "惠氏", "雀巢"])("%s既有关联产品规则保存继续正常", async (brandName) => {
    const value = await fixture(brandName);
    const before = await db.campaignProduct.findMany({ where: { campaignId: value.campaign.id } });
    await create(value, { productId: value.primary.id });
    expect(await db.campaignProduct.findMany({ where: { campaignId: value.campaign.id } })).toEqual(before);
  });
});
