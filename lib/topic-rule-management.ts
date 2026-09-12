import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { normalizeTopic } from "@/lib/topic";
import {
  campaignContainsProduct,
  isTopicRuleScope,
  resolveTopicRuleOwnership,
  topicRuleSemanticKey,
  type TopicRuleScope,
} from "@/lib/topic-rule-model";

export const topicRuleStatuses = ["ACTIVE", "INACTIVE"] as const;
export const topicRuleContentChannels = ["XIAOHONGSHU", "DOUYIN"] as const;

export type TopicRuleStatus = (typeof topicRuleStatuses)[number];
export type TopicRuleContentChannel =
  (typeof topicRuleContentChannels)[number];

export function topicRuleListWhere(input: {
  campaignId?: string;
  productId?: string;
  brandName?: string;
  month?: string;
  contentChannel?: string;
}): Prisma.TopicRuleWhereInput {
  return {
    campaignId: input.campaignId,
    productId: input.productId,
    brandName: input.brandName,
    ...(input.contentChannel
      ? { contentChannel: { in: [input.contentChannel, "ALL"] } }
      : {}),
  };
}

export class TopicRuleManagementError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

function hasOwn(source: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function assertExpectedBrand(
  expectedBrandName: string | undefined,
  actualBrandName: string | null,
) {
  if (
    expectedBrandName !== undefined &&
    expectedBrandName !== actualBrandName
  ) {
    throw new TopicRuleManagementError("规则不属于当前品牌", 403);
  }
}

function readRequestedStatus(value: unknown): TopicRuleStatus | undefined {
  if (value === undefined) return undefined;
  if (value === "ACTIVE" || value === "INACTIVE") return value;
  throw new TopicRuleManagementError("规则状态只能是 ACTIVE 或 INACTIVE");
}

function readContentChannel(value: unknown) {
  if (value === undefined) return undefined;
  if (value === "XIAOHONGSHU" || value === "DOUYIN" || value === "ALL") {
    return value;
  }
  throw new TopicRuleManagementError("规则内容渠道无效");
}

function readOptionalText(value: unknown) {
  return typeof value === "string" ? value.trim() || null : null;
}

async function resolveManagedRuleOwnership(
  tx: Prisma.TransactionClient,
  input: {
    scope: TopicRuleScope;
    brandName: string;
    productId?: string | null;
    campaignId?: string | null;
    contentChannel?: string;
    selectedMonth?: string | null;
  },
) {
  const productId = input.productId?.trim() || null;
  const campaignId = input.campaignId?.trim() || null;
  if (input.scope === "GLOBAL") {
    if (productId || campaignId) {
      throw new TopicRuleManagementError("通用规则不能绑定活动或产品");
    }
    return {
      productId: null,
      campaignId: null,
      contentChannel: input.contentChannel || "XIAOHONGSHU",
      campaign: null,
    };
  }
  if (input.scope === "PRODUCT" && (!productId || !campaignId)) {
    throw new TopicRuleManagementError("产品规则必须同时选择所属产品和所属活动");
  }
  if (input.scope === "PRODUCT" && !input.selectedMonth) {
    throw new TopicRuleManagementError("产品规则必须提供当前规则月份");
  }
  if (input.scope === "CAMPAIGN" && !campaignId) {
    throw new TopicRuleManagementError("活动规则必须选择所属活动");
  }
  if (input.scope === "CAMPAIGN" && productId) {
    throw new TopicRuleManagementError("活动规则不能绑定具体产品");
  }

  const [product, campaign] = await Promise.all([
    productId
      ? tx.product.findFirst({
          where: { id: productId, deletedAt: null },
          select: { id: true, brandName: true },
        })
      : null,
    campaignId
      ? tx.campaign.findFirst({
          where: { id: campaignId, deletedAt: null },
          include: {
            product: { select: { id: true, brandName: true } },
            products: {
              select: {
                productId: true,
                product: { select: { id: true, brandName: true } },
              },
            },
          },
        })
      : null,
  ]);
  if (productId && (!product || product.brandName !== input.brandName)) {
    throw new TopicRuleManagementError("所选产品不属于当前品牌");
  }
  const campaignBrands = new Set([
    campaign?.product?.brandName,
    ...(campaign?.products || []).map(({ product: item }) => item.brandName),
  ].filter(Boolean));
  if (!campaign || !campaignBrands.has(input.brandName)) {
    throw new TopicRuleManagementError("所选活动不属于当前品牌");
  }
  if (productId && !campaignContainsProduct(campaign, productId)) {
    throw new TopicRuleManagementError("所选产品不属于当前活动");
  }
  const contentChannel = input.contentChannel || campaign.contentChannel;
  if (contentChannel !== campaign.contentChannel) {
    throw new TopicRuleManagementError("规则内容平台与所属活动不一致");
  }
  if (
    input.scope === "PRODUCT" &&
    input.selectedMonth &&
    input.selectedMonth !== campaign.month
  ) {
    throw new TopicRuleManagementError("所属活动与当前规则月份不一致");
  }
  return { productId, campaignId, contentChannel, campaign };
}

async function assertNoTopicRuleDuplicate(
  tx: Prisma.TransactionClient,
  input: {
    id?: string;
    scope: TopicRuleScope;
    brandName: string;
    productId: string | null;
    campaignId: string | null;
    contentChannel: string;
    topic: string;
    applicableStage: string | null;
    milkType: string | null;
  },
) {
  const candidates = await tx.topicRule.findMany({
    where: {
      ...(input.id ? { id: { not: input.id } } : {}),
      brandName: input.brandName,
      contentChannel: input.contentChannel,
      topic: input.topic,
      applicableStage: input.applicableStage,
      milkType: input.milkType,
    },
    include: {
      product: { select: { id: true, brandName: true } },
      campaign: {
        include: {
          product: { select: { id: true, brandName: true } },
          products: {
            select: {
              productId: true,
              product: { select: { id: true, brandName: true } },
            },
          },
        },
      },
    },
  });
  const requestedKey = topicRuleSemanticKey(input);
  const duplicate = candidates.find((candidate) => {
    const ownership = resolveTopicRuleOwnership(candidate);
    return topicRuleSemanticKey({
      ...candidate,
      scope: ownership.scope,
      productId: ownership.productId,
      campaignId: ownership.campaignId,
    }) === requestedKey;
  });
  if (duplicate) {
    throw new TopicRuleManagementError("同一归属、平台、话题和阶段的规则已存在", 409);
  }
}

export async function createTopicRuleInTransaction(
  tx: Prisma.TransactionClient,
  input: { userId: string; body: Record<string, unknown> },
) {
  const brandName = readOptionalText(input.body.brandName);
  const topic = typeof input.body.topic === "string"
    ? normalizeTopic(input.body.topic)
    : "";
  const scope = input.body.scope ?? "CAMPAIGN";
  if (!brandName) throw new TopicRuleManagementError("规则必须归属品牌");
  if (!isTopicRuleScope(scope)) throw new TopicRuleManagementError("规则层级无效");
  if (typeof input.body.ruleType !== "string" || !topic) {
    throw new TopicRuleManagementError("规则类型和标准话题为必填项");
  }
  const requestedChannel = readContentChannel(input.body.contentChannel);
  const ownership = await resolveManagedRuleOwnership(tx, {
    scope,
    brandName,
    productId: readOptionalText(input.body.productId),
    campaignId: readOptionalText(input.body.campaignId),
    contentChannel: requestedChannel,
    selectedMonth: readOptionalText(input.body.selectedMonth),
  });
  const applicableStage = readOptionalText(input.body.applicableStage);
  const milkType = readOptionalText(input.body.milkType);
  await assertNoTopicRuleDuplicate(tx, {
    scope,
    brandName,
    productId: ownership.productId,
    campaignId: ownership.campaignId,
    contentChannel: ownership.contentChannel,
    topic,
    applicableStage,
    milkType,
  });
  let version = 1;
  if (ownership.campaignId) {
    version = (
      await tx.campaign.update({
        where: { id: ownership.campaignId },
        data: { ruleVersion: { increment: 1 } },
      })
    ).ruleVersion;
  }
  const rule = await tx.topicRule.create({
    data: {
      ruleSource: "LOCAL_DRAFT",
      brandName,
      contentChannel: ownership.contentChannel,
      campaignId: ownership.campaignId,
      productId: ownership.productId,
      scope,
      ruleType: input.body.ruleType,
      topicCategory: readOptionalText(input.body.topicCategory) || "GENERAL",
      applicableStage,
      milkType,
      topic,
      exactMatch: typeof input.body.exactMatch === "boolean" ? input.body.exactMatch : true,
      clickableRequired:
        typeof input.body.clickableRequired === "boolean"
          ? input.body.clickableRequired
          : false,
      caseSensitive:
        typeof input.body.caseSensitive === "boolean" ? input.body.caseSensitive : false,
      minCount: typeof input.body.minCount === "number" ? input.body.minCount : 1,
      sortOrder: typeof input.body.sortOrder === "number" ? input.body.sortOrder : 0,
      version,
      notes: readOptionalText(input.body.notes),
    },
    include: { campaign: true, product: true },
  });
  await tx.operationLog.create({
    data: {
      userId: input.userId,
      action: "CREATE_RULE",
      entityType: "TOPIC_RULE",
      entityId: rule.id,
      summary: `新增规则 ${rule.topic}`,
      metadata: JSON.stringify({
        ruleId: rule.id,
        scope: rule.scope,
        brandName: rule.brandName,
        productId: rule.productId,
        campaignId: rule.campaignId,
        contentChannel: rule.contentChannel,
      }),
    },
  });
  return rule;
}

export function createTopicRule(input: {
  userId: string;
  body: Record<string, unknown>;
}) {
  return prisma.$transaction((tx) => createTopicRuleInTransaction(tx, input));
}

export function normalizeMonthlyTopicRuleDeletionInput(value: unknown): {
  brandName: string;
  month: string;
  contentChannel: TopicRuleContentChannel;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TopicRuleManagementError("删除范围格式不正确");
  }
  const body = value as Record<string, unknown>;
  const brandName =
    typeof body.brandName === "string" ? body.brandName.trim() : "";
  const month = typeof body.month === "string" ? body.month.trim() : "";
  if (!brandName) {
    throw new TopicRuleManagementError("品牌不能为空");
  }
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(month)) {
    throw new TopicRuleManagementError("规则月份格式应为 YYYY-MM");
  }
  if (
    body.contentChannel !== "XIAOHONGSHU" &&
    body.contentChannel !== "DOUYIN"
  ) {
    throw new TopicRuleManagementError("内容渠道无效");
  }
  return {
    brandName,
    month,
    contentChannel: body.contentChannel,
  };
}

export function monthlyTopicRuleWhere(input: {
  brandName: string;
  month: string;
  contentChannel: TopicRuleContentChannel;
}): Prisma.TopicRuleWhereInput {
  return {
    brandName: input.brandName,
    contentChannel: { in: [input.contentChannel, "ALL"] },
    campaign: { is: { month: input.month, deletedAt: null } },
  };
}

export async function updateTopicRuleInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    id: string;
    userId: string;
    expectedBrandName?: string;
    body: Record<string, unknown>;
  },
) {
  const existing = await tx.topicRule.findUnique({
    where: { id: input.id },
    include: {
      campaign: {
        include: {
          product: { select: { id: true, brandName: true } },
          products: {
            select: {
              productId: true,
              product: { select: { id: true, brandName: true } },
            },
          },
        },
      },
      product: true,
    },
  });
  if (!existing) {
    throw new TopicRuleManagementError("规则不存在", 404);
  }
  assertExpectedBrand(input.expectedBrandName, existing.brandName);

  const requestedStatus = readRequestedStatus(input.body.status);
  const contentChannel = readContentChannel(input.body.contentChannel);
  const existingOwnership = resolveTopicRuleOwnership(existing);
  const requestedScope = hasOwn(input.body, "scope")
    ? input.body.scope
    : existingOwnership.scope;
  if (!isTopicRuleScope(requestedScope)) {
    throw new TopicRuleManagementError("规则层级无效");
  }
  const mutableFields = [
    "scope",
    "campaignId",
    "productId",
    "ruleType",
    "contentChannel",
    "topicCategory",
    "applicableStage",
    "milkType",
    "topic",
    "exactMatch",
    "clickableRequired",
    "caseSensitive",
    "minCount",
    "sortOrder",
    "status",
    "notes",
  ];
  if (
    !mutableFields.some((field) => hasOwn(input.body, field)) ||
    (requestedStatus === existing.status &&
      !mutableFields.some(
        (field) => field !== "status" && hasOwn(input.body, field),
      ))
  ) {
    return existing;
  }

  const normalizedTopic =
    typeof input.body.topic === "string"
      ? normalizeTopic(input.body.topic)
      : undefined;
  if (typeof input.body.topic === "string" && !normalizedTopic) {
    throw new TopicRuleManagementError("标准话题不能为空");
  }

  const brandName = existing.brandName?.trim();
  if (!brandName) throw new TopicRuleManagementError("规则必须归属品牌");
  const requestedProductId = hasOwn(input.body, "productId")
    ? readOptionalText(input.body.productId)
    : existingOwnership.productId;
  const requestedCampaignId = hasOwn(input.body, "campaignId")
    ? readOptionalText(input.body.campaignId)
    : existingOwnership.campaignId;
  const ownership = await resolveManagedRuleOwnership(tx, {
    scope: requestedScope,
    brandName,
    productId: requestedProductId,
    campaignId: requestedCampaignId,
    contentChannel: contentChannel || existing.contentChannel,
    selectedMonth:
      readOptionalText(input.body.selectedMonth) ||
      (requestedCampaignId === existing.campaignId ? existing.campaign?.month : null),
  });
  const nextTopic = normalizedTopic || existing.topic;
  const applicableStage = hasOwn(input.body, "applicableStage")
    ? readOptionalText(input.body.applicableStage)
    : existing.applicableStage;
  const milkType = hasOwn(input.body, "milkType")
    ? readOptionalText(input.body.milkType)
    : existing.milkType;
  await assertNoTopicRuleDuplicate(tx, {
    id: existing.id,
    scope: requestedScope,
    brandName,
    productId: ownership.productId,
    campaignId: ownership.campaignId,
    contentChannel: ownership.contentChannel,
    topic: nextTopic,
    applicableStage,
    milkType,
  });

  let version = existing.version + 1;
  const affectedCampaignIds = [
    ...new Set(
      [existing.campaignId, ownership.campaignId].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  ];
  for (const affectedCampaignId of affectedCampaignIds) {
    const campaign = await tx.campaign.update({
      where: { id: affectedCampaignId },
      data: { ruleVersion: { increment: 1 } },
    });
    if (affectedCampaignId === ownership.campaignId) version = campaign.ruleVersion;
  }
  const rule = await tx.topicRule.update({
    where: { id: input.id },
    data: {
      ruleSource: "LOCAL_DRAFT",
      scope: requestedScope,
      campaignId: ownership.campaignId,
      productId: ownership.productId,
      ...(typeof input.body.ruleType === "string"
        ? { ruleType: input.body.ruleType }
        : {}),
      contentChannel: ownership.contentChannel,
      ...(typeof input.body.topicCategory === "string"
        ? { topicCategory: input.body.topicCategory.trim() }
        : {}),
      ...(hasOwn(input.body, "applicableStage") ? { applicableStage } : {}),
      ...(hasOwn(input.body, "milkType") ? { milkType } : {}),
      ...(normalizedTopic ? { topic: normalizedTopic } : {}),
      ...(typeof input.body.exactMatch === "boolean"
        ? { exactMatch: input.body.exactMatch }
        : {}),
      ...(typeof input.body.clickableRequired === "boolean"
        ? { clickableRequired: input.body.clickableRequired }
        : {}),
      ...(typeof input.body.caseSensitive === "boolean"
        ? { caseSensitive: input.body.caseSensitive }
        : {}),
      ...(typeof input.body.minCount === "number"
        ? { minCount: input.body.minCount }
        : {}),
      ...(typeof input.body.sortOrder === "number"
        ? { sortOrder: input.body.sortOrder }
        : {}),
      ...(requestedStatus ? { status: requestedStatus } : {}),
      ...(typeof input.body.notes === "string"
        ? { notes: input.body.notes.trim() }
        : {}),
      version,
    },
    include: { campaign: true, product: true },
  });
  const statusChanged =
    requestedStatus !== undefined && requestedStatus !== existing.status;
  const action = statusChanged
    ? requestedStatus === "ACTIVE"
      ? "ENABLE_RULE"
      : "DISABLE_RULE"
    : "UPDATE_RULE";
  await tx.operationLog.create({
    data: {
      userId: input.userId,
      action,
      entityType: "TOPIC_RULE",
      entityId: rule.id,
      summary: statusChanged
        ? `${requestedStatus === "ACTIVE" ? "启用" : "停用"}规则 ${rule.topic}`
        : `更新规则 ${rule.topic}`,
      metadata: JSON.stringify({
        ruleId: rule.id,
        topic: rule.topic,
        campaignId: rule.campaignId,
        brandName: rule.brandName,
        contentChannel: rule.contentChannel,
        previousStatus: existing.status,
        status: rule.status,
        version: rule.version,
      }),
    },
  });
  return rule;
}

export function updateTopicRule(input: {
  id: string;
  userId: string;
  expectedBrandName?: string;
  body: Record<string, unknown>;
}) {
  return prisma.$transaction((tx) => updateTopicRuleInTransaction(tx, input));
}

export async function deleteTopicRuleInTransaction(
  tx: Prisma.TransactionClient,
  input: { id: string; userId: string; expectedBrandName?: string },
) {
  const existing = await tx.topicRule.findUnique({ where: { id: input.id } });
  if (!existing) {
    throw new TopicRuleManagementError("规则不存在", 404);
  }
  assertExpectedBrand(input.expectedBrandName, existing.brandName);
  let campaignRuleVersion: number | null = null;
  if (existing.campaignId) {
    const campaign = await tx.campaign.update({
      where: { id: existing.campaignId },
      data: { ruleVersion: { increment: 1 } },
    });
    campaignRuleVersion = campaign.ruleVersion;
  }
  await tx.topicRule.delete({ where: { id: existing.id } });
  await tx.operationLog.create({
    data: {
      userId: input.userId,
      action: "DELETE_RULE",
      entityType: "TOPIC_RULE",
      entityId: existing.id,
      summary: `永久删除规则 ${existing.topic}`,
      metadata: JSON.stringify({
        ruleId: existing.id,
        topic: existing.topic,
        campaignId: existing.campaignId,
        brandName: existing.brandName,
        contentChannel: existing.contentChannel,
      }),
    },
  });
  return {
    deletedCount: 1,
    ruleId: existing.id,
    campaignRuleVersion,
  };
}

export function deleteTopicRule(input: {
  id: string;
  userId: string;
  expectedBrandName?: string;
}) {
  return prisma.$transaction((tx) => deleteTopicRuleInTransaction(tx, input));
}

export async function deleteMonthlyTopicRulesInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    brandName: string;
    month: string;
    contentChannel: TopicRuleContentChannel;
  },
) {
  const where = monthlyTopicRuleWhere(input);
  const rules = await tx.topicRule.findMany({
    where,
    select: { id: true, campaignId: true, topic: true },
  });
  const campaignIds = [
    ...new Set(
      rules
        .map(({ campaignId }) => campaignId)
        .filter((campaignId): campaignId is string => Boolean(campaignId)),
    ),
  ];
  const campaignVersions: Record<string, number> = {};
  for (const campaignId of campaignIds) {
    const campaign = await tx.campaign.update({
      where: { id: campaignId },
      data: { ruleVersion: { increment: 1 } },
    });
    campaignVersions[campaignId] = campaign.ruleVersion;
  }
  const deleted = await tx.topicRule.deleteMany({ where });
  if (deleted.count !== rules.length) {
    throw new Error("话题规则批量删除数量不一致");
  }
  await tx.operationLog.create({
    data: {
      userId: input.userId,
      action: "BULK_DELETE_RULES",
      entityType: "TOPIC_RULE",
      entityId: null,
      summary: `永久删除 ${input.brandName} ${input.month} ${input.contentChannel} 话题规则 ${deleted.count} 条`,
      metadata: JSON.stringify({
        brandName: input.brandName,
        month: input.month,
        contentChannel: input.contentChannel,
        deletedCount: deleted.count,
        ruleIds: rules.map(({ id }) => id),
        topics: rules.map(({ topic }) => topic),
        campaignIds,
        campaignVersions,
      }),
    },
  });
  return {
    deletedCount: deleted.count,
    campaignIds,
    campaignVersions,
  };
}

export function deleteMonthlyTopicRules(input: {
  userId: string;
  brandName: string;
  month: string;
  contentChannel: TopicRuleContentChannel;
}) {
  return prisma.$transaction((tx) =>
    deleteMonthlyTopicRulesInTransaction(tx, input),
  );
}
