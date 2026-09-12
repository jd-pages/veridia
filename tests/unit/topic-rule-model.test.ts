import { describe, expect, it } from "vitest";
import {
  effectiveTopicRulesForContext,
  resolveTopicRuleOwnership,
  topicRuleSemanticKey,
} from "@/lib/topic-rule-model";

const product = { id: "product-a", brandName: "测试品牌" };
const campaign = {
  id: "campaign-a",
  name: "测试品牌2026年9月活动",
  month: "2026-09",
  contentChannel: "XIAOHONGSHU",
  productId: null,
  product: null,
  products: [{ productId: product.id, product }],
};

function rule(overrides: Record<string, unknown> = {}) {
  return {
    id: "rule-base",
    scope: "CAMPAIGN",
    topicCategory: "GENERAL",
    brandName: "测试品牌",
    productId: null,
    campaignId: campaign.id,
    contentChannel: "XIAOHONGSHU",
    topic: "#测试话题",
    applicableStage: null,
    milkType: null,
    status: "ACTIVE",
    product: null,
    campaign,
    ...overrides,
  };
}

describe("话题规则三级模型", () => {
  it("GLOBAL brand common 清除产品和活动归属", () => {
    expect(resolveTopicRuleOwnership(rule({ topicCategory: "BRAND_COMMON" }))).toMatchObject({
      scope: "GLOBAL",
      productId: null,
      campaignId: null,
      status: "VALID",
      resolutionBasis: "TOPIC_CATEGORY_BRAND_COMMON",
    });
  });

  it("GLOBAL stage topic 保留阶段语义但不绑定产品和活动", () => {
    expect(resolveTopicRuleOwnership(rule({
      topicCategory: "PRODUCT_STAGE",
      applicableStage: "IFFO_2",
      milkType: "IFFO",
    }))).toMatchObject({
      scope: "GLOBAL",
      productId: null,
      campaignId: null,
      status: "VALID",
      resolutionBasis: "TOPIC_CATEGORY_PRODUCT_STAGE",
    });
  });

  it("legacy PRODUCT without campaign 被明确识别为待绑定", () => {
    expect(resolveTopicRuleOwnership(rule({
      scope: "PRODUCT",
      productId: product.id,
      campaignId: null,
      product,
      campaign: null,
    }))).toMatchObject({
      scope: "PRODUCT",
      status: "UNRESOLVED_ACTIVITY_BINDING",
      campaignId: null,
    });
  });

  it("唯一结构候选生成 deterministic binding candidate", () => {
    expect(resolveTopicRuleOwnership(rule({
      scope: "PRODUCT",
      productId: product.id,
      campaignId: null,
      product,
      campaign: null,
    }), [campaign])).toMatchObject({
      status: "DETERMINISTIC_BINDING_CANDIDATE",
      campaignId: campaign.id,
      candidateCampaignIds: [campaign.id],
    });
  });

  it("多个结构候选保持 unresolved，绝不按顺序猜活动", () => {
    const second = { ...campaign, id: "campaign-b", name: "另一个活动" };
    expect(resolveTopicRuleOwnership(rule({
      scope: "PRODUCT",
      productId: product.id,
      campaignId: null,
      product,
      campaign: null,
    }), [campaign, second])).toMatchObject({
      status: "UNRESOLVED_ACTIVITY_BINDING",
      campaignId: null,
      candidateCampaignIds: ["campaign-a", "campaign-b"],
    });
  });

  it("有效审核规则组合 GLOBAL + exact PRODUCT + exact CAMPAIGN", () => {
    const rules = [
      rule({ id: "global", scope: "GLOBAL", campaignId: null, campaign: null }),
      rule({ id: "product", scope: "PRODUCT", productId: product.id, product }),
      rule({ id: "campaign" }),
      rule({ id: "other-product", scope: "PRODUCT", productId: "other", product: { id: "other", brandName: "测试品牌" } }),
      rule({ id: "legacy", scope: "PRODUCT", productId: product.id, campaignId: null, product, campaign: null }),
    ];
    expect(effectiveTopicRulesForContext(rules, {
      brandName: "测试品牌",
      productId: product.id,
      campaignId: campaign.id,
      contentChannel: "XIAOHONGSHU",
    }).map((item) => item.id)).toEqual(["global", "product", "campaign"]);
  });

  it("阶段 GLOBAL 只应用当前兼容阶段，相同话题不同阶段不互相去重", () => {
    const stageRules = [
      rule({ id: "stage-1", scope: "GLOBAL", campaignId: null, campaign: null, topicCategory: "PRODUCT_STAGE", applicableStage: "IFFO_P1" }),
      rule({ id: "stage-2", scope: "GLOBAL", campaignId: null, campaign: null, topicCategory: "PRODUCT_STAGE", applicableStage: "IFFO_2" }),
    ];
    expect(effectiveTopicRulesForContext(stageRules, {
      brandName: "测试品牌",
      productId: product.id,
      campaignId: campaign.id,
      contentChannel: "XIAOHONGSHU",
      compatibleStages: ["IFFO_2"],
    }).map((item) => item.id)).toEqual(["stage-2"]);
    expect(topicRuleSemanticKey(stageRules[0])).not.toBe(topicRuleSemanticKey(stageRules[1]));
  });

  it("同一完整语义键会去重", () => {
    const duplicate = rule({ id: "duplicate" });
    expect(effectiveTopicRulesForContext([rule(), duplicate], {
      brandName: "测试品牌",
      productId: product.id,
      campaignId: campaign.id,
      contentChannel: "XIAOHONGSHU",
    })).toHaveLength(1);
  });
});
