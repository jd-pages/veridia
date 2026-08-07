import { prisma } from "@/lib/db";
import type {
  RulePackageCampaign,
  RulePackagePayload,
  RulePackageTopicRule,
} from "./types";

export const DOUYIN_EXCLUDED_REQUIRED_TOPIC = "爱他美新手爸妈日记";

export function normalizedDouyinCopyTopic(value: string) {
  return value.trim().replace(/^#/u, "");
}

export function isExcludedDouyinRequiredTopic(value: string) {
  return normalizedDouyinCopyTopic(value) === DOUYIN_EXCLUDED_REQUIRED_TOPIC;
}

export function douyinCampaignKey(sourceKey: string) {
  return `douyin_${sourceKey}`;
}

export function douyinTopicRuleKey(sourceKey: string) {
  return `douyin_${sourceKey}`;
}

export function douyinCampaignName(sourceName: string) {
  if (!sourceName.includes("小红书")) {
    throw new Error(`小红书活动名称无法生成抖音副本：${sourceName}`);
  }
  return sourceName.replace("小红书", "抖音");
}

export function buildDouyinRuleCopies(payload: RulePackagePayload) {
  const sources = payload.campaigns.filter(
    (campaign) =>
      campaign.contentChannel === "XIAOHONGSHU" &&
      campaign.status === "ACTIVE" &&
      campaign.name.includes("小红书") &&
      !/(?:测试|mock|fixture|e2e)/iu.test(campaign.name),
  );
  const sourceKeys = new Set(sources.map((campaign) => campaign.key));
  const campaigns: RulePackageCampaign[] = sources.map((campaign) => ({
    ...campaign,
    key: douyinCampaignKey(campaign.key),
    contentChannel: "DOUYIN",
    name: douyinCampaignName(campaign.name),
    publicRequired: false,
  }));
  const topicRules: RulePackageTopicRule[] = payload.topicRules
    .filter(
      (rule) =>
        rule.status === "ACTIVE" &&
        rule.contentChannel === "XIAOHONGSHU" &&
        Boolean(rule.campaignKey && sourceKeys.has(rule.campaignKey)) &&
        !isExcludedDouyinRequiredTopic(rule.topic),
    )
    .map((rule) => ({
      ...rule,
      key: douyinTopicRuleKey(rule.key),
      campaignKey: douyinCampaignKey(rule.campaignKey!),
      contentChannel: "DOUYIN",
    }));
  return { campaigns, topicRules };
}

export async function ensureBuiltinDouyinRules(payload: RulePackagePayload) {
  const copies = buildDouyinRuleCopies(payload);
  const productIds = new Map<string, string>();
  for (const product of payload.products) {
    const existing =
      (await prisma.product.findUnique({
        where: { publishedKey: product.key },
        select: { id: true },
      })) ||
      (await prisma.product.findFirst({
        where: { name: product.name, deletedAt: null },
        select: { id: true },
      }));
    if (existing) productIds.set(product.key, existing.id);
  }

  const campaignIds = new Map<string, string>();
  let createdCampaigns = 0;
  let createdTopicRules = 0;
  let createdProductRelations = 0;
  for (const item of copies.campaigns) {
    let campaign = await prisma.campaign.findUnique({
      where: { publishedKey: item.key },
      select: { id: true, publicRequired: true },
    });
    if (!campaign) {
      const linkedProducts = item.productKeys
        .map((key) => productIds.get(key))
        .filter((id): id is string => Boolean(id));
      if (linkedProducts.length !== item.productKeys.length) {
        throw new Error(`抖音活动产品关联不完整：${item.name}`);
      }
      campaign = await prisma.campaign.create({
        data: {
          publishedKey: item.key,
          ruleSource: "LOCAL_DRAFT",
          productId: null,
          name: item.name,
          contentChannel: "DOUYIN",
          month: item.month,
          year: item.year,
          startDate: new Date(item.startDate),
          endDate: new Date(item.endDate),
          minImageCount: item.minImageCount,
          productImageRequired: item.productImageRequired,
          firstImageRequirement: item.firstImageRequirement,
          prohibitedImageGuidance: item.prohibitedImageGuidance,
          bodyRequired: item.bodyRequired,
          minBodyLength: item.minBodyLength,
          publicRequired: false,
          retentionDays: item.retentionDays,
          rewardDescription: item.rewardDescription,
          visualReviewGuidance: item.visualReviewGuidance,
          customerRegistrationNotes: item.customerRegistrationNotes,
          clickableTopicRequired: item.clickableTopicRequired,
          ruleVersion: item.ruleRevision,
          status: item.status,
          products: {
            create: linkedProducts.map((productId, sortOrder) => ({
              productId,
              sortOrder,
            })),
          },
        },
        select: { id: true, publicRequired: true },
      });
      createdCampaigns += 1;
      createdProductRelations += linkedProducts.length;
    } else if (campaign.publicRequired) {
      campaign = await prisma.campaign.update({
        where: { id: campaign.id },
        data: { publicRequired: false },
        select: { id: true, publicRequired: true },
      });
    }
    campaignIds.set(item.key, campaign.id);
  }

  const productBrandByKey = new Map(
    payload.products.map((product) => [product.key, product.brand]),
  );
  const campaignBrandByKey = new Map(
    payload.campaigns.map((campaign) => [
      campaign.key,
      payload.products.find((product) =>
        campaign.productKeys.includes(product.key),
      )?.brand || null,
    ]),
  );
  for (const item of copies.topicRules) {
    const existing = await prisma.topicRule.findUnique({
      where: { publishedKey: item.key },
      select: { id: true },
    });
    if (existing) continue;
    const sourceCampaignKey = item.campaignKey?.replace(/^douyin_/u, "") || null;
    await prisma.topicRule.create({
      data: {
        publishedKey: item.key,
        ruleSource: "LOCAL_DRAFT",
        campaignId: item.campaignKey
          ? campaignIds.get(item.campaignKey) || null
          : null,
        productId: item.productKey ? productIds.get(item.productKey) || null : null,
        brandName:
          item.brand ||
          (item.productKey ? productBrandByKey.get(item.productKey) : null) ||
          (sourceCampaignKey ? campaignBrandByKey.get(sourceCampaignKey) : null) ||
          null,
        contentChannel: "DOUYIN",
        scope: item.scope,
        ruleType: item.ruleType,
        topicCategory: item.topicCategory,
        applicableStage: item.applicableStage,
        milkType: item.milkType,
        topic: item.topic,
        exactMatch: item.exactMatch,
        clickableRequired: item.clickableRequired,
        caseSensitive: item.caseSensitive,
        minCount: item.minCount,
        sortOrder: item.sortOrder,
        version: item.revision,
        status: item.status,
        notes: item.notes,
      },
    });
    createdTopicRules += 1;
  }

  const [products, activities, stageGroups, topicRules] = await Promise.all([
    prisma.product.count({ where: { deletedAt: null } }),
    prisma.campaign.count({ where: { deletedAt: null } }),
    prisma.ruleStageGroup.count(),
    prisma.topicRule.count(),
  ]);
  await prisma.ruleSyncState.updateMany({
    where: { id: "active" },
    data: {
      countsJson: JSON.stringify({ products, activities, stageGroups, topicRules }),
    },
  });

  return {
    sourceCampaigns: copies.campaigns.length,
    expectedTopicRules: copies.topicRules.length,
    createdCampaigns,
    createdTopicRules,
    createdProductRelations,
  };
}
