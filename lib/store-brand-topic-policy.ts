import { parseContentChannel } from "@/lib/result-source";
import { storeTopicWithHash, type StoreTopicResolution } from "@/lib/store-topic-config";

export interface StoreBrandTopicPolicyConfig {
  brandName: string;
  contentChannel: string;
  requireStoreTopic: boolean;
  useSharedTemplate: boolean;
  topicConfig: string;
  reviewStatus?: string;
  managedBy?: string;
}

export function scopeStoreTopicsByPolicy(resolution: StoreTopicResolution, brandName: unknown, channel: unknown) {
  const brand = String(brandName ?? "").trim();
  const contentChannel = parseContentChannel(channel);
  const policies = resolution.config?.brandPolicies || [];
  const matches = policies.filter(policy => policy.brandName === brand && policy.contentChannel === contentChannel);
  const policy = matches.length === 1 ? matches[0] : null;
  let expectedTopics: string[] = [], requiredTopics: string[] = [], configurationError: string | null = null;
  if (matches.length > 1) configurationError = "STORE_BRAND_POLICY_DUPLICATE：店铺品牌配置重复，请管理员确认。";
  if (policy?.requireStoreTopic) {
    if (policy.useSharedTemplate) {
      expectedTopics = resolution.expectedTopics;
      requiredTopics = resolution.requiredTopics;
    } else {
      try {
        const parsed = JSON.parse(policy.topicConfig) as { acceptedTopics: unknown; requiredTopics: unknown };
        if (!Array.isArray(parsed.acceptedTopics) || !Array.isArray(parsed.requiredTopics) ||
          [...parsed.acceptedTopics, ...parsed.requiredTopics].some(value => typeof value !== "string" || !storeTopicWithHash(value))) throw new Error("INVALID");
        expectedTopics = parsed.acceptedTopics.map(storeTopicWithHash);
        requiredTopics = parsed.requiredTopics.map(storeTopicWithHash);
      } catch { configurationError = "STORE_BRAND_POLICY_INVALID：品牌话题配置无效，请管理员确认。"; }
    }
    const effectiveRequired = contentChannel === "XIAOHONGSHU" ? requiredTopics : [];
    if (!expectedTopics.length && !effectiveRequired.length) {
      configurationError = "STORE_BRAND_POLICY_TOPICS_MISSING：已开启品牌店铺话题审核，但没有当前内容渠道的有效话题。";
    }
  }
  // No implicit inheritance: unconfigured brands remain pending in management,
  // and cannot acquire another brand's requirement. Invalid explicit ON fails closed.
  return {
    ...resolution, expectedTopic: expectedTopics[0] || null, expectedTopics, requiredTopics, configurationError,
    storeBrandTopicPolicy: { schemaVersion: 1, brandName: brand, contentChannel,
      requireStoreTopic: policy?.requireStoreTopic ?? false, useSharedTemplate: policy?.useSharedTemplate ?? true,
      reviewStatus: policy?.reviewStatus ?? "PENDING_REVIEW", expectedTopics, requiredTopics, configurationError },
  };
}
