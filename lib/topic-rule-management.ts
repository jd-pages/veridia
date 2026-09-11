import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { normalizeTopic } from "@/lib/topic";

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
  const brandRuleWindow = input.brandName && !input.campaignId && !input.productId
    ? input.month
      ? {
          OR: [
            { campaignId: null },
            { campaign: { is: { month: input.month, deletedAt: null } } },
          ],
        }
      : { campaignId: null }
    : {};
  return {
    campaignId: input.campaignId,
    productId: input.productId,
    brandName: input.brandName,
    ...(input.contentChannel
      ? { contentChannel: { in: [input.contentChannel, "ALL"] } }
      : {}),
    ...brandRuleWindow,
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
    include: { campaign: true, product: true },
  });
  if (!existing) {
    throw new TopicRuleManagementError("规则不存在", 404);
  }
  assertExpectedBrand(input.expectedBrandName, existing.brandName);

  const requestedStatus = readRequestedStatus(input.body.status);
  const contentChannel = readContentChannel(input.body.contentChannel);
  let productId: string | undefined;
  if (existing.scope === "PRODUCT" && hasOwn(input.body, "productId")) {
    productId =
      typeof input.body.productId === "string"
        ? input.body.productId.trim()
        : "";
    if (!productId) {
      throw new TopicRuleManagementError("产品规则必须选择所属产品");
    }
    const product = await tx.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: { brandName: true },
    });
    if (!product || product.brandName !== existing.brandName) {
      throw new TopicRuleManagementError("所选产品不属于当前品牌");
    }
  }
  const mutableFields = [
    "ruleType",
    "contentChannel",
    "topic",
    "exactMatch",
    "clickableRequired",
    "caseSensitive",
    "minCount",
    "sortOrder",
    "status",
    "notes",
    ...(existing.scope === "PRODUCT" ? ["productId"] : []),
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

  let version = existing.version + 1;
  if (existing.campaignId) {
    const campaign = await tx.campaign.update({
      where: { id: existing.campaignId },
      data: { ruleVersion: { increment: 1 } },
    });
    version = campaign.ruleVersion;
  }
  const rule = await tx.topicRule.update({
    where: { id: input.id },
    data: {
      ruleSource: "LOCAL_DRAFT",
      ...(typeof input.body.ruleType === "string"
        ? { ruleType: input.body.ruleType }
        : {}),
      ...(contentChannel ? { contentChannel } : {}),
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
      ...(productId ? { productId } : {}),
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
