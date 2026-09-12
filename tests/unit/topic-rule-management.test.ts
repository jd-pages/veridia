import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTopicRuleInTransaction,
  deleteMonthlyTopicRulesInTransaction,
  deleteTopicRuleInTransaction,
  monthlyTopicRuleWhere,
  normalizeMonthlyTopicRuleDeletionInput,
  topicRuleListWhere,
  updateTopicRuleInTransaction,
} from "@/lib/topic-rule-management";
import {
  applyRulePayload,
  exportCurrentRulePayload,
} from "@/lib/rules/package";
import { removeTemporaryDirectoryWithRetry } from "@/tests/helpers/remove-temporary-directory";

const root = process.cwd();
let temporaryRoot = "";
let source: PrismaClient;
let target: PrismaClient;

function databaseUrl(databasePath: string) {
  return `file:${databasePath.replaceAll("\\", "/")}`;
}

async function createCampaign(
  client: PrismaClient,
  input: {
    id: string;
    name: string;
    month: string;
    contentChannel: "XIAOHONGSHU" | "DOUYIN";
    productId: string;
    ruleVersion?: number;
  },
) {
  return client.campaign.create({
    data: {
      ...input,
      startDate: new Date(`${input.month}-01T00:00:00.000Z`),
      endDate: new Date(`${input.month}-28T23:59:59.000Z`),
      ruleSource: "LOCAL_DRAFT",
    },
  });
}

async function createRule(
  client: PrismaClient,
  input: {
    id: string;
    campaignId: string;
    brandName: string;
    contentChannel: "XIAOHONGSHU" | "DOUYIN" | "ALL";
    topic: string;
    status?: "ACTIVE" | "INACTIVE";
    version?: number;
  },
) {
  return client.topicRule.create({
    data: {
      ...input,
      ruleSource: "LOCAL_DRAFT",
      scope: "CAMPAIGN",
      ruleType: "MUST_ALL",
      topicCategory: "GENERAL",
    },
  });
}

async function createOwnershipFixture(suffix: string) {
  const brandName = `三级模型品牌-${suffix}`;
  const otherBrandName = `其他品牌-${suffix}`;
  const product = await source.product.create({
    data: { code: `MODEL-A-${suffix}`, name: `模型产品A-${suffix}`, brandName },
  });
  const secondProduct = await source.product.create({
    data: { code: `MODEL-B-${suffix}`, name: `模型产品B-${suffix}`, brandName },
  });
  const otherProduct = await source.product.create({
    data: { code: `MODEL-X-${suffix}`, name: `其他产品-${suffix}`, brandName: otherBrandName },
  });
  const campaign = await createCampaign(source, {
    id: `model-campaign-${suffix}`,
    name: `模型活动-${suffix}`,
    month: "2026-09",
    contentChannel: "XIAOHONGSHU",
    productId: product.id,
    ruleVersion: 5,
  });
  const secondCampaign = await createCampaign(source, {
    id: `model-campaign-2-${suffix}`,
    name: `模型活动二-${suffix}`,
    month: "2026-09",
    contentChannel: "XIAOHONGSHU",
    productId: secondProduct.id,
    ruleVersion: 8,
  });
  const userId = (
    await source.user.findFirstOrThrow({ where: { role: "ADMIN" } })
  ).id;
  return { brandName, product, secondProduct, otherProduct, campaign, secondCampaign, userId };
}

beforeAll(async () => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veridia-rule-management-"));
  execFileSync(
    process.execPath,
    [path.join(root, "scripts", "testing", "e2e-database-template.mjs")],
    { cwd: root, env: process.env, stdio: "pipe", windowsHide: true },
  );
  const template = path.join(root, ".playwright", "e2e-template", "baseline.db");
  const sourcePath = path.join(temporaryRoot, "source.db");
  const targetPath = path.join(temporaryRoot, "target.db");
  fs.copyFileSync(template, sourcePath);
  fs.copyFileSync(template, targetPath);
  fs.chmodSync(sourcePath, 0o600);
  fs.chmodSync(targetPath, 0o600);
  source = new PrismaClient({ datasourceUrl: databaseUrl(sourcePath) });
  target = new PrismaClient({ datasourceUrl: databaseUrl(targetPath) });
}, 30_000);

afterAll(async () => {
  await source?.$disconnect();
  await target?.$disconnect();
  if (temporaryRoot) await removeTemporaryDirectoryWithRetry(temporaryRoot);
}, 30_000);

describe.sequential("话题规则启停与永久删除", () => {
  it("PRODUCT create requires product + campaign", async () => {
    const fixture = await createOwnershipFixture(`required-${Date.now().toString(36)}`);
    await expect(source.$transaction((tx) => createTopicRuleInTransaction(tx, {
      userId: fixture.userId,
      body: {
        scope: "PRODUCT",
        brandName: fixture.brandName,
        productId: fixture.product.id,
        selectedMonth: "2026-09",
        contentChannel: "XIAOHONGSHU",
        ruleType: "MUST_ALL",
        topic: "#必须双绑定",
      },
    }))).rejects.toThrow("必须同时选择所属产品和所属活动");
    await expect(source.$transaction((tx) => createTopicRuleInTransaction(tx, {
      userId: fixture.userId,
      body: {
        scope: "PRODUCT",
        brandName: fixture.brandName,
        productId: fixture.product.id,
        campaignId: fixture.campaign.id,
        selectedMonth: "2026-09",
        contentChannel: "XIAOHONGSHU",
        ruleType: "MUST_ALL",
        topic: "#合法双绑定",
      },
    }))).resolves.toMatchObject({
      scope: "PRODUCT",
      productId: fixture.product.id,
      campaignId: fixture.campaign.id,
    });
  });

  it("PRODUCT rejects product not in campaign", async () => {
    const fixture = await createOwnershipFixture(`member-${Date.now().toString(36)}`);
    await expect(source.$transaction((tx) => createTopicRuleInTransaction(tx, {
      userId: fixture.userId,
      body: {
        scope: "PRODUCT",
        brandName: fixture.brandName,
        productId: fixture.secondProduct.id,
        campaignId: fixture.campaign.id,
        selectedMonth: "2026-09",
        contentChannel: "XIAOHONGSHU",
        ruleType: "MUST_ALL",
        topic: "#错误活动成员",
      },
    }))).rejects.toThrow("所选产品不属于当前活动");
  });

  it("PRODUCT rejects campaign channel mismatch", async () => {
    const fixture = await createOwnershipFixture(`channel-${Date.now().toString(36)}`);
    await expect(source.$transaction((tx) => createTopicRuleInTransaction(tx, {
      userId: fixture.userId,
      body: {
        scope: "PRODUCT",
        brandName: fixture.brandName,
        productId: fixture.product.id,
        campaignId: fixture.campaign.id,
        selectedMonth: "2026-09",
        contentChannel: "DOUYIN",
        ruleType: "MUST_ALL",
        topic: "#错误活动平台",
      },
    }))).rejects.toThrow("规则内容平台与所属活动不一致");
  });

  it("PRODUCT edit preserves and validates campaign/product relation", async () => {
    const fixture = await createOwnershipFixture(`edit-${Date.now().toString(36)}`);
    const created = await source.$transaction((tx) => createTopicRuleInTransaction(tx, {
      userId: fixture.userId,
      body: {
        scope: "PRODUCT",
        brandName: fixture.brandName,
        productId: fixture.product.id,
        campaignId: fixture.campaign.id,
        selectedMonth: "2026-09",
        contentChannel: "XIAOHONGSHU",
        ruleType: "MUST_ALL",
        topic: "#编辑保持关系",
      },
    }));
    await expect(source.$transaction((tx) => updateTopicRuleInTransaction(tx, {
      id: created.id,
      userId: fixture.userId,
      expectedBrandName: fixture.brandName,
      body: { sortOrder: 25 },
    }))).resolves.toMatchObject({
      productId: fixture.product.id,
      campaignId: fixture.campaign.id,
      sortOrder: 25,
    });
    await expect(source.$transaction((tx) => updateTopicRuleInTransaction(tx, {
      id: created.id,
      userId: fixture.userId,
      expectedBrandName: fixture.brandName,
      body: {
        productId: fixture.product.id,
        campaignId: fixture.secondCampaign.id,
        selectedMonth: "2026-09",
      },
    }))).rejects.toThrow("所选产品不属于当前活动");
  });

  it("CAMPAIGN rules must not bind a product", async () => {
    const fixture = await createOwnershipFixture(`campaign-${Date.now().toString(36)}`);
    await expect(source.$transaction((tx) => createTopicRuleInTransaction(tx, {
      userId: fixture.userId,
      body: {
        scope: "CAMPAIGN",
        brandName: fixture.brandName,
        productId: fixture.product.id,
        campaignId: fixture.campaign.id,
        contentChannel: "XIAOHONGSHU",
        ruleType: "MUST_ALL",
        topic: "#活动不可绑产品",
      },
    }))).rejects.toThrow("活动规则不能绑定具体产品");
  });

  it("品牌视角先读取全部结构规则，再由 API 按有效层级和月份投影", () => {
    expect(
      topicRuleListWhere({
        brandName: "惠氏",
        month: "2026-09",
        contentChannel: "XIAOHONGSHU",
      }),
    ).toEqual({
      campaignId: undefined,
      productId: undefined,
      brandName: "惠氏",
      contentChannel: { in: ["XIAOHONGSHU", "ALL"] },
    });
    expect(
      topicRuleListWhere({
        brandName: "惠氏",
        contentChannel: "XIAOHONGSHU",
      }),
    ).toMatchObject({ brandName: "惠氏", campaignId: undefined });
  });

  it("严格解析 selectedMonth 范围并与 GET 的渠道可见性一致", () => {
    expect(
      normalizeMonthlyTopicRuleDeletionInput({
        brandName: " 佳贝艾特 ",
        month: "2026-09",
        contentChannel: "XIAOHONGSHU",
      }),
    ).toEqual({
      brandName: "佳贝艾特",
      month: "2026-09",
      contentChannel: "XIAOHONGSHU",
    });
    expect(
      monthlyTopicRuleWhere({
        brandName: "佳贝艾特",
        month: "2026-09",
        contentChannel: "XIAOHONGSHU",
      }),
    ).toEqual({
      brandName: "佳贝艾特",
      contentChannel: { in: ["XIAOHONGSHU", "ALL"] },
      campaign: { is: { month: "2026-09", deletedAt: null } },
    });
    expect(() =>
      normalizeMonthlyTopicRuleDeletionInput({
        brandName: "佳贝艾特",
        month: "2026-9",
        contentChannel: "XIAOHONGSHU",
      }),
    ).toThrow(/YYYY-MM/u);
  });

  it("状态可逆、删除物理生效、批量版本只加一且隔离品牌渠道月份", async () => {
    const suffix = Date.now().toString(36);
    const userId = (
      await source.user.findFirstOrThrow({ where: { role: "ADMIN" } })
    ).id;
    const brandA = `规则管理品牌A-${suffix}`;
    const brandB = `规则管理品牌B-${suffix}`;
    const productA = await source.product.create({
      data: {
        id: `product-a-${suffix}`,
        code: `RULE-A-${suffix}`,
        name: `规则管理产品A-${suffix}`,
        brandName: brandA,
      },
    });
    const productB = await source.product.create({
      data: {
        id: `product-b-${suffix}`,
        code: `RULE-B-${suffix}`,
        name: `规则管理产品B-${suffix}`,
        brandName: brandB,
      },
    });
    const productA2 = await source.product.create({
      data: {
        id: `product-a2-${suffix}`,
        code: `RULE-A2-${suffix}`,
        name: `规则管理产品A2-${suffix}`,
        brandName: brandA,
      },
    });
    const september = await createCampaign(source, {
      id: `campaign-september-${suffix}`,
      name: `规则管理九月-${suffix}`,
      month: "2026-09",
      contentChannel: "XIAOHONGSHU",
      productId: productA.id,
      ruleVersion: 10,
    });
    const august = await createCampaign(source, {
      id: `campaign-august-${suffix}`,
      name: `规则管理八月-${suffix}`,
      month: "2026-08",
      contentChannel: "XIAOHONGSHU",
      productId: productA.id,
      ruleVersion: 20,
    });
    const douyin = await createCampaign(source, {
      id: `campaign-douyin-${suffix}`,
      name: `规则管理抖音-${suffix}`,
      month: "2026-09",
      contentChannel: "DOUYIN",
      productId: productA.id,
      ruleVersion: 30,
    });
    const otherBrand = await createCampaign(source, {
      id: `campaign-brand-b-${suffix}`,
      name: `规则管理品牌B九月-${suffix}`,
      month: "2026-09",
      contentChannel: "XIAOHONGSHU",
      productId: productB.id,
      ruleVersion: 40,
    });
    const auditResultCount = await source.auditResult.count();
    const reversible = await createRule(source, {
      id: `rule-reversible-${suffix}`,
      campaignId: september.id,
      brandName: brandA,
      contentChannel: "XIAOHONGSHU",
      topic: `#可逆规则${suffix}`,
      version: 10,
    });

    const productRule = await source.topicRule.create({
      data: {
        id: `rule-product-${suffix}`,
        ruleSource: "LOCAL_DRAFT",
        scope: "PRODUCT",
        productId: productA.id,
        campaignId: september.id,
        brandName: brandA,
        contentChannel: "XIAOHONGSHU",
        ruleType: "MUST_ALL",
        topicCategory: "PRODUCT_COMMON",
        topic: `#产品规则${suffix}`,
      },
    });
    await source.campaignProduct.create({
      data: { campaignId: september.id, productId: productA2.id, sortOrder: 1 },
    });
    await expect(
      source.$transaction((tx) =>
        updateTopicRuleInTransaction(tx, {
          id: productRule.id,
          userId,
          expectedBrandName: brandA,
          body: { productId: productB.id, selectedMonth: "2026-09" },
        }),
      ),
    ).rejects.toThrow("所选产品不属于当前品牌");
    const movedProductRule = await source.$transaction((tx) =>
      updateTopicRuleInTransaction(tx, {
        id: productRule.id,
        userId,
        expectedBrandName: brandA,
        body: { productId: productA2.id, selectedMonth: "2026-09" },
      }),
    );
    expect(movedProductRule).toMatchObject({
      id: productRule.id,
      productId: productA2.id,
      campaignId: september.id,
      version: 11,
      product: { id: productA2.id, brandName: brandA },
    });

    const disabled = await source.$transaction((tx) =>
      updateTopicRuleInTransaction(tx, {
        id: reversible.id,
        userId,
        expectedBrandName: brandA,
        body: { status: "INACTIVE" },
      }),
    );
    expect(disabled).toMatchObject({
      id: reversible.id,
      status: "INACTIVE",
      ruleSource: "LOCAL_DRAFT",
      version: 12,
    });
    const enabled = await source.$transaction((tx) =>
      updateTopicRuleInTransaction(tx, {
        id: reversible.id,
        userId,
        expectedBrandName: brandA,
        body: { status: "ACTIVE" },
      }),
    );
    expect(enabled).toMatchObject({
      id: reversible.id,
      status: "ACTIVE",
      version: 13,
    });
    expect(
      await source.campaign.findUniqueOrThrow({ where: { id: september.id } }),
    ).toMatchObject({ ruleVersion: 13 });

    const firstPayload = await exportCurrentRulePayload(
      {
        ruleVersion: "rules-2026.09.01.1",
        minimumAppVersion: "1.1.21",
      },
      source,
    );
    expect(firstPayload.topicRules.some((rule) => rule.topic === reversible.topic)).toBe(true);
    expect(firstPayload.topicRules.find((rule) => rule.topic === productRule.topic)).toMatchObject({
      scope: "PRODUCT",
      productKey: expect.any(String),
      campaignKey: expect.any(String),
    });
    await applyRulePayload(firstPayload, "GITHUB", target);
    expect(
      await target.topicRule.findFirst({ where: { topic: reversible.topic } }),
    ).toMatchObject({ status: "ACTIVE", ruleSource: "GITHUB" });
    expect(
      await target.topicRule.findFirst({
        where: { topic: productRule.topic },
        include: { product: true, campaign: true },
      }),
    ).toMatchObject({
      scope: "PRODUCT",
      product: { name: productA2.name },
      campaign: { name: september.name },
    });

    const deleted = await source.$transaction((tx) =>
      deleteTopicRuleInTransaction(tx, {
        id: reversible.id,
        userId,
        expectedBrandName: brandA,
      }),
    );
    expect(deleted).toMatchObject({ deletedCount: 1, ruleId: reversible.id });
    expect(await source.topicRule.findUnique({ where: { id: reversible.id } })).toBeNull();
    expect(await source.campaign.findUnique({ where: { id: september.id } })).not.toBeNull();
    expect(await source.product.findUnique({ where: { id: productA.id } })).not.toBeNull();
    expect(await source.auditResult.count()).toBe(auditResultCount);

    const secondPayload = await exportCurrentRulePayload(
      {
        ruleVersion: "rules-2026.09.01.2",
        minimumAppVersion: "1.1.21",
      },
      source,
    );
    expect(secondPayload.topicRules.some((rule) => rule.topic === reversible.topic)).toBe(false);
    await applyRulePayload(secondPayload, "GITHUB", target);
    expect(
      await target.topicRule.findFirst({ where: { topic: reversible.topic } }),
    ).toBeNull();

    for (let index = 1; index <= 7; index += 1) {
      await createRule(source, {
        id: `rule-september-${index}-${suffix}`,
        campaignId: september.id,
        brandName: brandA,
        contentChannel: "XIAOHONGSHU",
        topic: `#九月规则${index}${suffix}`,
      });
    }
    const augustRule = await createRule(source, {
      id: `rule-august-${suffix}`,
      campaignId: august.id,
      brandName: brandA,
      contentChannel: "XIAOHONGSHU",
      topic: `#八月保留${suffix}`,
    });
    const douyinRule = await createRule(source, {
      id: `rule-douyin-${suffix}`,
      campaignId: douyin.id,
      brandName: brandA,
      contentChannel: "DOUYIN",
      topic: `#抖音保留${suffix}`,
    });
    const brandBRule = await createRule(source, {
      id: `rule-brand-b-${suffix}`,
      campaignId: otherBrand.id,
      brandName: brandB,
      contentChannel: "XIAOHONGSHU",
      topic: `#品牌B保留${suffix}`,
    });
    const versionBeforeBatch = (
      await source.campaign.findUniqueOrThrow({ where: { id: september.id } })
    ).ruleVersion;
    const batch = await source.$transaction((tx) =>
      deleteMonthlyTopicRulesInTransaction(tx, {
        userId,
        brandName: brandA,
        month: "2026-09",
        contentChannel: "XIAOHONGSHU",
      }),
    );
    expect(batch).toMatchObject({
      deletedCount: 8,
      campaignIds: [september.id],
    });
    expect(
      (
        await source.campaign.findUniqueOrThrow({ where: { id: september.id } })
      ).ruleVersion,
    ).toBe(versionBeforeBatch + 1);
    expect(await source.topicRule.count({
      where: monthlyTopicRuleWhere({
        brandName: brandA,
        month: "2026-09",
        contentChannel: "XIAOHONGSHU",
      }),
    })).toBe(0);
    for (const retained of [augustRule, douyinRule, brandBRule]) {
      expect(await source.topicRule.findUnique({ where: { id: retained.id } })).not.toBeNull();
    }
    expect(await source.auditResult.count()).toBe(auditResultCount);
    expect(
      await source.operationLog.findFirst({
        where: { action: "DELETE_RULE", entityId: reversible.id },
      }),
    ).toMatchObject({ entityType: "TOPIC_RULE" });
    const batchLog = await source.operationLog.findFirst({
      where: { action: "BULK_DELETE_RULES" },
      orderBy: { createdAt: "desc" },
    });
    expect(JSON.parse(batchLog?.metadata || "{}")).toMatchObject({
      brandName: brandA,
      month: "2026-09",
      contentChannel: "XIAOHONGSHU",
      deletedCount: 8,
      campaignIds: [september.id],
    });

    const recreated = await createRule(source, {
      id: `rule-recreated-${suffix}`,
      campaignId: september.id,
      brandName: brandA,
      contentChannel: "XIAOHONGSHU",
      topic: `#删除后重建${suffix}`,
    });
    expect(recreated.id).toBe(`rule-recreated-${suffix}`);
  }, 30_000);
});
