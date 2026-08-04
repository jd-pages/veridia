import { describe, expect, it } from "vitest";
import {
  campaignRequiresProductStage,
  rulesRequireAnyProductStage,
} from "@/lib/campaign-stage-requirement";

describe("活动产品阶段显示与校验", () => {
  it("没有阶段规则时不要求阶段", () => {
    expect(
      campaignRequiresProductStage([
        {
          campaignId: "kabrita",
          topicCategory: "BRAND_COMMON",
          applicableStage: null,
          topic: "#初见小温柔成长更友好",
        },
      ]),
    ).toBe(false);
  });

  it("兼容阶段都复用同一标准话题时不展示也不校验阶段", () => {
    expect(
      campaignRequiresProductStage([
        {
          campaignId: "kabrita",
          topicCategory: "BRAND_COMMON",
          applicableStage: null,
          topic: "#初见小温柔成长更友好",
        },
        ...["IFFO_P1", "IFFO_2", "GUM_3_4_1PLUS_2PLUS"].map(
          (applicableStage) => ({
            campaignId: "kabrita",
            topicCategory: "PRODUCT_STAGE",
            applicableStage,
            topic: "#初见小温柔成长更友好",
          }),
        ),
      ]),
    ).toBe(false);
  });

  it("不同阶段对应不同要求话题时继续要求选择阶段", () => {
    expect(
      campaignRequiresProductStage([
        {
          campaignId: "danone",
          topicCategory: "PRODUCT_STAGE",
          applicableStage: "IFFO_2",
          topic: "#二段奶粉推荐",
        },
        {
          campaignId: "danone",
          topicCategory: "PRODUCT_STAGE",
          applicableStage: "GUM_3_4_1PLUS_2PLUS",
          topic: "#三段奶粉推荐",
        },
      ]),
    ).toBe(true);
  });

  it("品牌下任一活动有真实阶段要求时保留阶段模块", () => {
    expect(
      rulesRequireAnyProductStage([
        {
          campaignId: "compatibility",
          topicCategory: "BRAND_COMMON",
          topic: "#通用话题",
        },
        {
          campaignId: "compatibility",
          topicCategory: "PRODUCT_STAGE",
          applicableStage: "IFFO_2",
          topic: "#通用话题",
        },
        {
          campaignId: "stage-required",
          topicCategory: "PRODUCT_STAGE",
          applicableStage: "GUM_3_4_1PLUS_2PLUS",
          topic: "#三段奶粉推荐",
        },
      ]),
    ).toBe(true);
  });
});
