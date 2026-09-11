import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
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
  it("品牌月份视角同时返回通用/产品规则与当前月活动规则", () => {
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
      OR: [
        { campaignId: null },
        { campaign: { is: { month: "2026-09", deletedAt: null } } },
      ],
    });
    expect(
      topicRuleListWhere({
        brandName: "惠氏",
        contentChannel: "XIAOHONGSHU",
      }),
    ).toMatchObject({ brandName: "惠氏", campaignId: null });
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
        brandName: brandA,
        contentChannel: "XIAOHONGSHU",
        ruleType: "MUST_ALL",
        topicCategory: "PRODUCT_COMMON",
        topic: `#产品规则${suffix}`,
      },
    });
    await expect(
      source.$transaction((tx) =>
        updateTopicRuleInTransaction(tx, {
          id: productRule.id,
          userId,
          expectedBrandName: brandA,
          body: { productId: productB.id },
        }),
      ),
    ).rejects.toThrow("所选产品不属于当前品牌");
    const movedProductRule = await source.$transaction((tx) =>
      updateTopicRuleInTransaction(tx, {
        id: productRule.id,
        userId,
        expectedBrandName: brandA,
        body: { productId: productA2.id },
      }),
    );
    expect(movedProductRule).toMatchObject({
      id: productRule.id,
      productId: productA2.id,
      version: 2,
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
      version: 11,
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
      version: 12,
    });
    expect(
      await source.campaign.findUniqueOrThrow({ where: { id: september.id } }),
    ).toMatchObject({ ruleVersion: 12 });

    const firstPayload = await exportCurrentRulePayload(
      {
        ruleVersion: "rules-2026.09.01.1",
        minimumAppVersion: "1.1.21",
      },
      source,
    );
    expect(firstPayload.topicRules.some((rule) => rule.topic === reversible.topic)).toBe(true);
    await applyRulePayload(firstPayload, "GITHUB", target);
    expect(
      await target.topicRule.findFirst({ where: { topic: reversible.topic } }),
    ).toMatchObject({ status: "ACTIVE", ruleSource: "GITHUB" });

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
      deletedCount: 7,
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
      deletedCount: 7,
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
