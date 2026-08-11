import { prisma } from "@/lib/db";
import { campaignRequiresProductStage } from "@/lib/campaign-stage-requirement";
import {
  campaignUsesDetailedProductStages,
  compatibleStageRuleValues,
  DETAILED_PRODUCT_STAGE_OPTIONS,
  normalizeProductStageTopicValue,
  PRODUCT_STAGE_TOPIC_OPTIONS,
} from "@/lib/product-stage";
import type { AutomationPlatform } from "@/lib/automation/platform";

export interface CampaignProductStageRule {
  id: string;
  status?: string;
  productId: string | null;
  topicCategory: string;
  applicableStage: string | null;
  milkType: string | null;
  topic: string;
}

export interface CampaignProductStageOption {
  value: string;
  label: string;
}

export function productScopedCampaignRules(
  rules: readonly CampaignProductStageRule[],
  productId: string,
) {
  return rules.filter(
    (rule) => !rule.productId || rule.productId === productId,
  );
}

export function campaignProductStageOptions(input: {
  rules: readonly CampaignProductStageRule[];
  productId: string;
  detailed: boolean;
}) {
  const scopedRules = productScopedCampaignRules(input.rules, input.productId);
  const options = input.detailed
    ? DETAILED_PRODUCT_STAGE_OPTIONS
    : PRODUCT_STAGE_TOPIC_OPTIONS;
  return options
    .filter((option) =>
      scopedRules.some((rule) => {
        if (rule.topicCategory !== "PRODUCT_STAGE") return false;
        if (input.detailed) return rule.applicableStage === option.value;
        return (
          rule.milkType === option.value ||
          normalizeProductStageTopicValue(rule.applicableStage) === option.value
        );
      }),
    )
    .map(({ value, label }) => ({ value, label }));
}

export function findCampaignProductStageRule(input: {
  rules: readonly CampaignProductStageRule[];
  productId: string;
  productStage: string | null;
}) {
  if (!input.productStage) return null;
  const compatibleStages = compatibleStageRuleValues(input.productStage);
  return (
    productScopedCampaignRules(input.rules, input.productId).find(
      (rule) =>
        rule.topicCategory === "PRODUCT_STAGE" &&
        compatibleStages.includes(rule.applicableStage || ""),
    ) || null
  );
}

export async function resolveCampaignProductStageConfiguration(input: {
  campaignId: string;
  productId: string;
  contentChannel: AutomationPlatform;
}) {
  const [campaign, product] = await Promise.all([
    prisma.campaign.findFirst({
      where: {
        id: input.campaignId,
        status: "ACTIVE",
        deletedAt: null,
        OR: [
          { productId: input.productId },
          { products: { some: { productId: input.productId } } },
        ],
      },
      select: {
        id: true,
        name: true,
        month: true,
        contentChannel: true,
      },
    }),
    prisma.product.findFirst({
      where: {
        id: input.productId,
        status: "ACTIVE",
        deletedAt: null,
      },
      select: { id: true, name: true, brandName: true },
    }),
  ]);
  if (!campaign || !product) {
    throw new Error("活动不存在、已停用或与所选产品不匹配");
  }
  if (![input.contentChannel, "ALL"].includes(campaign.contentChannel)) {
    throw new Error("内容渠道与活动渠道不一致，请选择对应内容平台的审核活动");
  }
  const configuredRules = await prisma.topicRule.findMany({
    where: {
      campaignId: input.campaignId,
      brandName: product.brandName,
      contentChannel: { in: [input.contentChannel, "ALL"] },
    },
    select: {
      id: true,
      status: true,
      productId: true,
      topicCategory: true,
      applicableStage: true,
      milkType: true,
      topic: true,
    },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  const rules = configuredRules.filter((rule) => rule.status === "ACTIVE");
  const detailed = campaignUsesDetailedProductStages(
    product.brandName,
    campaign.month,
  );
  return {
    campaign,
    product,
    rules,
    detailed,
    requiresProductStage: campaignRequiresProductStage(configuredRules),
    stageOptions: campaignProductStageOptions({
      rules,
      productId: input.productId,
      detailed,
    }),
  };
}
