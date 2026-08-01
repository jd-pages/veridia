import { describe, expect, it } from "vitest";
import {
  PRODUCT_STAGE_TOPIC_OPTIONS,
  bodyStageRequiredFromRuleSnapshot,
  detectBodyProductStages,
  detectProductStage,
  normalizeProductStage,
  normalizeProductStageTopicValue,
  productStageTopicLabel,
  resolveConfiguredProductStage,
  stageTopicFromRuleSnapshot,
} from "@/lib/product-stage";

describe("product stage topic mapping", () => {
  it("只暴露原始Excel表头对应的三个产品阶段话题选项", () => {
    expect(PRODUCT_STAGE_TOPIC_OPTIONS).toEqual([
      { value: "IFFO_P1", label: "IFFO：P段/1段" },
      { value: "IFFO_2", label: "IFFO：2段" },
      {
        value: "GUM_3_4_1PLUS_2PLUS",
        label: "GUM：3段/4段/1+段/2+段",
      },
    ]);
  });

  it.each(["P段", "PRE", "PRE段", "pre 段", "1段"])(
    "将 %s 映射为 IFFO：P段/1段",
    (value) => {
      const result = detectProductStage([value]);
      expect(result.status).toBe("MATCHED");
      expect(result.group).toBe("IFFO_P1");
      expect(result.groupLabel).toBe("IFFO：P段/1段");
    },
  );

  it("2段单独映射为 IFFO：2段", () => {
    const result = detectProductStage(["爱他美 2段"]);
    expect(result.group).toBe("IFFO_2");
    expect(result.groupLabel).toBe("IFFO：2段");
    expect(result.preferredStage).toBe("2段");
  });

  it.each(["3段", "4段", "1+段", "2+段"])(
    "将 %s 映射为 GUM：3段/4段/1+段/2+段",
    (value) => {
      const result = detectProductStage([value]);
      expect(result.group).toBe("GUM_3_4_1PLUS_2PLUS");
      expect(result.groupLabel).toBe("GUM：3段/4段/1+段/2+段");
    },
  );

  it("优先识别加号段位并兼容全角加号", () => {
    expect(detectProductStage(["1+段"]).matchedTokens).toEqual(["1+段"]);
    expect(detectProductStage(["2＋段"]).matchedTokens).toEqual(["2+段"]);
    expect(normalizeProductStage("１＋段")).toBe("1+段");
  });

  it("使用边界匹配，不把普通数字或更长数字识别为段位", () => {
    expect(detectProductStage(["宝宝已经12段楼梯"]).status).toBe("MISSING");
    expect(detectProductStage(["配方含有21段数据"]).status).toBe("MISSING");
    expect(detectProductStage(["第2段奶粉记录"]).matchedTokens).toEqual([
      "2段",
    ]);
  });

  it("同组多段位是OR关系，跨组才标记冲突", () => {
    const sameGroup = detectProductStage(["P段/1段/PRE"]);
    expect(sameGroup.status).toBe("MATCHED");
    expect(sameGroup.group).toBe("IFFO_P1");

    const conflict = detectProductStage(["1段和2段"]);
    expect(conflict.status).toBe("CONFLICT");
    expect(conflict.group).toBeNull();
  });

  it("兼容旧段位配置并解析为新的内部唯一值", () => {
    expect(normalizeProductStageTopicValue("P段")).toBe("IFFO_P1");
    expect(normalizeProductStageTopicValue("IFFO_NEWBORN")).toBe("IFFO_P1");
    expect(normalizeProductStageTopicValue("IFFO：2段")).toBe("IFFO_2");
    expect(normalizeProductStageTopicValue("GUM")).toBe(
      "GUM_3_4_1PLUS_2PLUS",
    );
    expect(productStageTopicLabel("IFFO_P1")).toBe("IFFO：P段/1段");
  });

  it("规则快照只有明确启用时才审核正文段位", () => {
    expect(bodyStageRequiredFromRuleSnapshot(JSON.stringify({}))).toBe(false);
    expect(
      bodyStageRequiredFromRuleSnapshot(
        JSON.stringify({ bodyStageRequired: false }),
      ),
    ).toBe(false);
    expect(
      bodyStageRequiredFromRuleSnapshot(
        JSON.stringify({ bodyStageRequired: true }),
      ),
    ).toBe(true);
  });

  it.each([
    ["IFFO_P1", "#新生儿奶粉"],
    ["IFFO_2", "#二段奶粉推荐"],
    ["GUM_3_4_1PLUS_2PLUS", "#三段奶粉推荐"],
  ])("规则快照中的 %s 阶段对应 %s", (stage, topic) => {
    expect(
      stageTopicFromRuleSnapshot(
        JSON.stringify({
          rules: [{ topicCategory: "PRODUCT_STAGE", applicableStage: stage, topic }],
        }),
      ),
    ).toBe(topic);
  });

  it("Excel具体段位只映射到活动已配置的对应产品阶段话题", () => {
    const detection = detectProductStage(["规格800g", "PRE段"]);
    expect(
      resolveConfiguredProductStage(detection, ["P段", "2段", "3段"]),
    ).toBe("IFFO_P1");
    expect(resolveConfiguredProductStage(detection, ["2段", "3段"])).toBeNull();
  });

  it("正文当前组选项命中任意段位即可通过，其他段位不直接导致失败", () => {
    const result = detectBodyProductStages(
      "宝宝现在喝3段，也回顾过2段时期的体验。",
      "GUM_3_4_1PLUS_2PLUS",
    );
    expect(result?.passed).toBe(true);
    expect(result?.matchedAllowedStages).toContain("3段");
    expect(result?.detectedStages).toContain("2段");
  });

  it("正文只出现其他组段位时返回OUTSIDE_GROUP", () => {
    const result = detectBodyProductStages(
      "这次记录宝宝喝2段奶粉的体验。",
      "IFFO_P1",
    );
    expect(result).toMatchObject({
      status: "OUTSIDE_GROUP",
      passed: false,
      detectedStages: ["2段"],
    });
  });

  it("话题文本中的段位不能代替正文段位", () => {
    const result = detectBodyProductStages(
      "真实体验分享 #二段奶粉推荐",
      "IFFO_2",
    );
    expect(result?.status).toBe("MISSING");
    expect(result?.passed).toBe(false);
  });

});
