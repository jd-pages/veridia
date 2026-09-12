import { normalizeTopic } from "@/lib/topic";

export const TOPIC_RULE_SCOPES = ["GLOBAL", "PRODUCT", "CAMPAIGN"] as const;

export type TopicRuleScope = (typeof TOPIC_RULE_SCOPES)[number];

export type TopicRuleBindingStatus =
  | "VALID"
  | "DETERMINISTIC_BINDING_CANDIDATE"
  | "UNRESOLVED_ACTIVITY_BINDING"
  | "UNRESOLVED_PRODUCT_BINDING"
  | "INVALID_RELATION";

export interface TopicRuleCampaignLike {
  id: string;
  name?: string | null;
  month?: string | null;
  contentChannel?: string | null;
  productId?: string | null;
  products?: ReadonlyArray<{
    productId?: string | null;
    product?: { id?: string | null; brandName?: string | null } | null;
  }>;
  product?: { id?: string | null; brandName?: string | null } | null;
}

export interface TopicRuleOwnershipInput {
  id?: string;
  scope: string;
  topicCategory?: string | null;
  brandName?: string | null;
  productId?: string | null;
  campaignId?: string | null;
  contentChannel?: string | null;
  topic?: string | null;
  applicableStage?: string | null;
  milkType?: string | null;
  product?: { id?: string | null; brandName?: string | null } | null;
  campaign?: TopicRuleCampaignLike | null;
}

export interface TopicRuleOwnershipResolution {
  scope: TopicRuleScope;
  productId: string | null;
  campaignId: string | null;
  status: TopicRuleBindingStatus;
  resolutionBasis: string;
  candidateCampaignIds: string[];
}

export function campaignProductIds(campaign: TopicRuleCampaignLike | null | undefined) {
  if (!campaign) return [];
  return [
    campaign.productId || campaign.product?.id || null,
    ...(campaign.products || []).map(
      (link) => link.productId || link.product?.id || null,
    ),
  ].filter((value): value is string => Boolean(value));
}

export function campaignContainsProduct(
  campaign: TopicRuleCampaignLike | null | undefined,
  productId: string | null | undefined,
) {
  return Boolean(productId && campaignProductIds(campaign).includes(productId));
}

function normalizedBrand(value: string | null | undefined) {
  return value?.trim() || null;
}

function campaignBrands(campaign: TopicRuleCampaignLike | null | undefined) {
  if (!campaign) return [];
  return [
    campaign.product?.brandName,
    ...(campaign.products || []).map((link) => link.product?.brandName),
  ]
    .map(normalizedBrand)
    .filter((value): value is string => Boolean(value));
}

export function resolveTopicRuleOwnership(
  rule: TopicRuleOwnershipInput,
  candidateCampaigns: readonly TopicRuleCampaignLike[] = [],
): TopicRuleOwnershipResolution {
  const brandName = normalizedBrand(rule.brandName);
  const productBrand = normalizedBrand(rule.product?.brandName);
  const category = rule.topicCategory || "GENERAL";

  if (category === "BRAND_COMMON") {
    return {
      scope: "GLOBAL",
      productId: null,
      campaignId: null,
      status: "VALID",
      resolutionBasis: "TOPIC_CATEGORY_BRAND_COMMON",
      candidateCampaignIds: [],
    };
  }
  if (category === "PRODUCT_STAGE") {
    return {
      scope: "GLOBAL",
      productId: null,
      campaignId: null,
      status: "VALID",
      resolutionBasis: "TOPIC_CATEGORY_PRODUCT_STAGE",
      candidateCampaignIds: [],
    };
  }

  if (rule.productId && rule.campaignId) {
    const validBrand =
      (!brandName || !productBrand || brandName === productBrand) &&
      (!brandName || !rule.campaign || campaignBrands(rule.campaign).includes(brandName));
    if (!validBrand || !campaignContainsProduct(rule.campaign, rule.productId)) {
      return {
        scope: "PRODUCT",
        productId: rule.productId,
        campaignId: rule.campaignId,
        status: "INVALID_RELATION",
        resolutionBasis: "PRODUCT_CAMPAIGN_RELATION_INVALID",
        candidateCampaignIds: [],
      };
    }
    return {
      scope: "PRODUCT",
      productId: rule.productId,
      campaignId: rule.campaignId,
      status: "VALID",
      resolutionBasis: "EXPLICIT_VALID_PRODUCT_AND_CAMPAIGN",
      candidateCampaignIds: [],
    };
  }

  if (rule.productId && !rule.campaignId) {
    const candidates = candidateCampaigns.filter((campaign) => {
      const channelMatches =
        !rule.contentChannel ||
        rule.contentChannel === "ALL" ||
        campaign.contentChannel === rule.contentChannel;
      const brandMatches =
        !brandName || campaignBrands(campaign).includes(brandName);
      return channelMatches && brandMatches && campaignContainsProduct(campaign, rule.productId);
    });
    return {
      scope: "PRODUCT",
      productId: rule.productId,
      campaignId: candidates.length === 1 ? candidates[0].id : null,
      status:
        candidates.length === 1
          ? "DETERMINISTIC_BINDING_CANDIDATE"
          : "UNRESOLVED_ACTIVITY_BINDING",
      resolutionBasis:
        candidates.length === 1
          ? "UNIQUE_PRODUCT_CHANNEL_CAMPAIGN_RELATION"
          : candidates.length === 0
            ? "NO_PRODUCT_CHANNEL_CAMPAIGN_RELATION"
            : "MULTIPLE_PRODUCT_CHANNEL_CAMPAIGN_RELATIONS",
      candidateCampaignIds: candidates.map((campaign) => campaign.id),
    };
  }

  if (category === "PRODUCT_COMMON" || rule.scope === "PRODUCT") {
    return {
      scope: "PRODUCT",
      productId: null,
      campaignId: rule.campaignId || null,
      status: "UNRESOLVED_PRODUCT_BINDING",
      resolutionBasis: "PRODUCT_RULE_WITHOUT_EXPLICIT_PRODUCT",
      candidateCampaignIds: [],
    };
  }

  if (rule.campaignId) {
    const validBrand =
      !brandName || !rule.campaign || campaignBrands(rule.campaign).includes(brandName);
    return {
      scope: "CAMPAIGN",
      productId: null,
      campaignId: rule.campaignId,
      status: validBrand ? "VALID" : "INVALID_RELATION",
      resolutionBasis: validBrand
        ? "CAMPAIGN_WITHOUT_PRODUCT"
        : "CAMPAIGN_BRAND_RELATION_INVALID",
      candidateCampaignIds: [],
    };
  }

  if (rule.scope === "GLOBAL") {
    return {
      scope: "GLOBAL",
      productId: null,
      campaignId: null,
      status: "VALID",
      resolutionBasis: "EXPLICIT_GLOBAL_WITHOUT_BINDINGS",
      candidateCampaignIds: [],
    };
  }

  return {
    scope: "CAMPAIGN",
    productId: null,
    campaignId: null,
    status: "INVALID_RELATION",
    resolutionBasis: "CAMPAIGN_RULE_WITHOUT_CAMPAIGN",
    candidateCampaignIds: [],
  };
}

export interface TopicRuleSemanticIdentity {
  scope: string;
  brandName?: string | null;
  brand?: string | null;
  productId?: string | null;
  productKey?: string | null;
  campaignId?: string | null;
  campaignKey?: string | null;
  contentChannel?: string | null;
  topic?: string | null;
  applicableStage?: string | null;
  milkType?: string | null;
}

export function topicRuleSemanticKey(rule: TopicRuleSemanticIdentity) {
  return [
    rule.scope,
    normalizedBrand(rule.brandName ?? rule.brand),
    rule.productId ?? rule.productKey ?? null,
    rule.campaignId ?? rule.campaignKey ?? null,
    rule.contentChannel || "XIAOHONGSHU",
    normalizeTopic(rule.topic || ""),
    rule.applicableStage?.trim() || null,
    rule.milkType?.trim() || null,
  ].map((value) => String(value ?? "")).join("\u001f");
}

export function isTopicRuleScope(value: unknown): value is TopicRuleScope {
  return TOPIC_RULE_SCOPES.includes(value as TopicRuleScope);
}

export function effectiveTopicRulesForContext<
  T extends TopicRuleOwnershipInput & { status?: string | null },
>(
  rules: readonly T[],
  context: {
    brandName: string;
    productId: string;
    campaignId: string;
    contentChannel: string;
    compatibleStages?: readonly string[];
  },
) {
  const compatibleStages = context.compatibleStages || [];
  const selected = rules.flatMap((rule) => {
    if (rule.status && rule.status !== "ACTIVE") return [];
    if (normalizedBrand(rule.brandName) !== normalizedBrand(context.brandName)) {
      return [];
    }
    if (
      rule.contentChannel &&
      ![context.contentChannel, "ALL"].includes(rule.contentChannel)
    ) {
      return [];
    }
    const ownership = resolveTopicRuleOwnership(rule);
    if (ownership.status !== "VALID") return [];
    const applies =
      ownership.scope === "GLOBAL" ||
      (ownership.scope === "PRODUCT" &&
        ownership.productId === context.productId &&
        ownership.campaignId === context.campaignId) ||
      (ownership.scope === "CAMPAIGN" &&
        ownership.campaignId === context.campaignId);
    if (!applies) return [];
    if (
      rule.applicableStage &&
      !compatibleStages.includes(rule.applicableStage)
    ) {
      return [];
    }
    return [{
      ...rule,
      scope: ownership.scope,
      productId: ownership.productId,
      campaignId: ownership.campaignId,
      bindingStatus: ownership.status,
      resolutionBasis: ownership.resolutionBasis,
    }];
  });
  const seen = new Set<string>();
  return selected.filter((rule) => {
    const key = topicRuleSemanticKey(rule);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
