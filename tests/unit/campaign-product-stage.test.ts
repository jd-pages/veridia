import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import {
  campaignProductStageOptions,
  findCampaignProductStageRule,
  type CampaignProductStageRule,
} from "@/lib/campaign-product-stage";

function rule(input: Partial<CampaignProductStageRule>): CampaignProductStageRule {
  return {
    id: input.id || crypto.randomUUID(),
    productId: input.productId ?? null,
    topicCategory: input.topicCategory || "PRODUCT_STAGE",
    applicableStage: input.applicableStage ?? null,
    milkType: input.milkType ?? null,
    topic: input.topic || "#阶段话题",
  };
}

describe("活动产品阶段配置", () => {
  const rules = [
    rule({ id: "global-gum", applicableStage: "GUM", milkType: "GUM" }),
    rule({ id: "product-a-iffo", productId: "product-a", applicableStage: "IFFO", milkType: "IFFO" }),
    rule({ id: "product-b-iffo", productId: "product-b", applicableStage: "IFFO", milkType: "IFFO" }),
  ];

  it("阶段选项只包含当前产品可用规则", () => {
    expect(campaignProductStageOptions({
      rules,
      productId: "product-a",
      detailed: false,
    })).toEqual([
      { value: "IFFO", label: "IFFO" },
      { value: "GUM", label: "GUM" },
    ]);
    expect(campaignProductStageOptions({
      rules: rules.filter((item) => item.id !== "global-gum"),
      productId: "product-a",
      detailed: false,
    })).toEqual([{ value: "IFFO", label: "IFFO" }]);
  });

  it("缺少当前产品阶段规则时不会借用其他产品规则", () => {
    expect(findCampaignProductStageRule({
      rules: rules.filter((item) => item.id !== "global-gum"),
      productId: "product-a",
      productStage: "GUM",
    })).toBeNull();
  });

  it("存在当前产品阶段规则时预检可精确匹配", () => {
    expect(findCampaignProductStageRule({
      rules,
      productId: "product-a",
      productStage: "IFFO",
    })?.id).toBe("product-a-iffo");
  });
});
