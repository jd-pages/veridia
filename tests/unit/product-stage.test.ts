import { describe, expect, it } from "vitest";
import {
  PRODUCT_STAGE_TOPIC_OPTIONS,
  DETAILED_PRODUCT_STAGE_OPTIONS,
  aggregateProductStageTopicRows,
  aggregateDetailedProductStageTopicRows,
  bodyStageRequiredFromRuleSnapshot,
  detectBodyProductStages,
  detectProductStage,
  compatibleStageRuleValues,
  campaignUsesDetailedProductStages,
  detailedProductStagePhase,
  normalizeDetailedProductStageValue,
  normalizeImportedProductStageTopicValue,
  normalizeProductStage,
  normalizeProductStageTopicValue,
  productStageTopicLabel,
  resolveConfiguredProductStage,
  stageTopicsForProductStage,
  stageTopicFromRuleSnapshot,
} from "@/lib/product-stage";

describe("product stage topic mapping", () => {
  it("用户界面只暴露 IFFO 和 GUM 两个阶段组选项", () => {
    expect(PRODUCT_STAGE_TOPIC_OPTIONS).toEqual([
      { value: "IFFO", label: "IFFO" },
      { value: "GUM", label: "GUM" },
    ]);
  });

  it("展示层将底层阶段规则聚合为一行 IFFO 和一行 GUM", () => {
    const rows = aggregateProductStageTopicRows([
      { key: "IFFO_P1", requiredTopic: "#新生儿奶粉", ruleSource: "BUILTIN" },
      { key: "IFFO_2", requiredTopic: "#二段奶粉推荐", ruleSource: "LOCAL_DRAFT" },
      {
        key: "GUM_3_4_1PLUS_2PLUS",
        requiredTopic: "#三段奶粉推荐",
        ruleSource: "BUILTIN",
      },
    ]);

    expect(rows.map(({ key, requiredTopics }) => ({ key, requiredTopics }))).toEqual([
      {
        key: "IFFO",
        requiredTopics: ["#新生儿奶粉", "#二段奶粉推荐"],
      },
      { key: "GUM", requiredTopics: ["#三段奶粉推荐"] },
    ]);
    expect(rows[0].members).toHaveLength(2);
  });

  it("达能 2026 年 8 月按三个具体段位组展示和匹配", () => {
    expect(campaignUsesDetailedProductStages("达能", "2026-08")).toBe(true);
    expect(campaignUsesDetailedProductStages("达能", "2026-07")).toBe(false);
    expect(DETAILED_PRODUCT_STAGE_OPTIONS.map((item) => item.value)).toEqual([
      "IFFO_P1",
      "IFFO_2",
      "GUM_3_4_1PLUS_2PLUS",
    ]);
    expect(aggregateDetailedProductStageTopicRows([
      { key: "IFFO_P1", requiredTopic: "#新生儿奶粉" },
      { key: "IFFO_2", requiredTopic: "#二段奶粉推荐" },
      { key: "GUM_3_4_1PLUS_2PLUS", requiredTopic: "#三段奶粉推荐" },
    ])).toHaveLength(3);
  });

  it.each([
    ["P段", "IFFO_P1", "IFFO"],
    ["1段", "IFFO_P1", "IFFO"],
    ["2段", "IFFO_2", "IFFO"],
    ["3段", "GUM_3_4_1PLUS_2PLUS", "GUM"],
    ["4段", "GUM_3_4_1PLUS_2PLUS", "GUM"],
    ["1+段", "GUM_3_4_1PLUS_2PLUS", "GUM"],
    ["2+段", "GUM_3_4_1PLUS_2PLUS", "GUM"],
  ])("具体段位 %s 只映射到 %s", (stage, expected, phase) => {
    expect(normalizeDetailedProductStageValue(stage)).toBe(expected);
    expect(detailedProductStagePhase(stage)).toBe(phase);
    expect(compatibleStageRuleValues(stage)).toEqual(
      expect.arrayContaining([expected]),
    );
  });

  it("8 月 IFFO 二段不会叠加新生儿组", () => {
    const values = compatibleStageRuleValues("IFFO_2");
    expect(values).toContain("IFFO_2");
    expect(values).not.toContain("IFFO_P1");
  });

  it("任务规则提示收集所选阶段组全部候选话题", () => {
    const rules = [
      { topic: "#爱他美奇迹绿罐", topicCategory: "PRODUCT" },
      {
        topic: "#新生儿奶粉",
        topicCategory: "PRODUCT_STAGE",
        applicableStage: "IFFO_P1",
      },
      {
        topic: "#二段奶粉推荐",
        topicCategory: "PRODUCT_STAGE",
        applicableStage: "IFFO_2",
      },
      {
        topic: "#三段奶粉推荐",
        topicCategory: "PRODUCT_STAGE",
        applicableStage: "GUM_3_4_1PLUS_2PLUS",
      },
    ];

    expect(stageTopicsForProductStage(rules, "IFFO")).toEqual([
      "#新生儿奶粉",
      "#二段奶粉推荐",
    ]);
    expect(stageTopicsForProductStage(rules, "GUM")).toEqual([
      "#三段奶粉推荐",
    ]);
  });

  it.each(["P段", "PRE", "PRE段", "pre 段", "1段", "2段"])(
    "底层将 %s 映射为 IFFO",
    (value) => {
      const result = detectProductStage([value]);
      expect(result.status).toBe("MATCHED");
      expect(result.group).toBe("IFFO");
      expect(result.groupLabel).toBe("IFFO");
    },
  );

  it("2段仍保留具体段位证据，但对外归入 IFFO", () => {
    const result = detectProductStage(["爱他美 2段"]);
    expect(result.group).toBe("IFFO");
    expect(result.groupLabel).toBe("IFFO");
    expect(result.preferredStage).toBe("2段");
  });

  it.each(["3段", "4段", "1+段", "2+段"])(
    "底层将 %s 映射为 GUM",
    (value) => {
      const result = detectProductStage([value]);
      expect(result.group).toBe("GUM");
      expect(result.groupLabel).toBe("GUM");
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
    const sameGroup = detectProductStage(["P段/1段/2段/PRE"]);
    expect(sameGroup.status).toBe("MATCHED");
    expect(sameGroup.group).toBe("IFFO");

    const conflict = detectProductStage(["2段和3段"]);
    expect(conflict.status).toBe("CONFLICT");
    expect(conflict.group).toBeNull();
  });

  it("历史内部键和完整段位串统一标准化为 IFFO / GUM", () => {
    expect(normalizeProductStageTopicValue("P段")).toBe("IFFO");
    expect(normalizeProductStageTopicValue("IFFO_NEWBORN")).toBe("IFFO");
    expect(normalizeProductStageTopicValue("IFFO：P段/1段")).toBe("IFFO");
    expect(normalizeProductStageTopicValue("IFFO：2段")).toBe("IFFO");
    expect(normalizeProductStageTopicValue("GUM_3_4_1PLUS_2PLUS")).toBe(
      "GUM",
    );
    expect(productStageTopicLabel("IFFO_P1")).toBe("IFFO 新生儿组（P段/1段）");
    expect(productStageTopicLabel("GUM：3段/4段/1+段/2+段")).toBe("GUM");
  });

  it("导入口径接受组名及旧完整串，但拒绝具体段位", () => {
    expect(normalizeImportedProductStageTopicValue(" iffo ")).toBe("IFFO");
    expect(normalizeImportedProductStageTopicValue("GUM")).toBe("GUM");
    expect(normalizeImportedProductStageTopicValue("IFFO：P段/1段")).toBe(
      "IFFO",
    );
    expect(normalizeImportedProductStageTopicValue("IFFO：2段")).toBe(
      "IFFO",
    );
    expect(
      normalizeImportedProductStageTopicValue("GUM：3段/4段/1+段/2+段"),
    ).toBe("GUM");
    for (const value of ["", "P段", "1段", "2段", "3段", "4段", "1+段", "2+段"]) {
      expect(normalizeImportedProductStageTopicValue(value)).toBeNull();
    }
  });

  it("IFFO / GUM 保留所有历史规则键和具体段位的兼容查询", () => {
    expect(compatibleStageRuleValues("IFFO")).toEqual(
      expect.arrayContaining(["IFFO_P1", "IFFO_2", "P段", "1段", "2段"]),
    );
    expect(compatibleStageRuleValues("GUM")).toEqual(
      expect.arrayContaining([
        "GUM_3_4_1PLUS_2PLUS",
        "3段",
        "4段",
        "1+段",
        "2+段",
      ]),
    );
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
    ).toBe("IFFO");
    expect(resolveConfiguredProductStage(detection, ["3段"])).toBeNull();
  });

  it("正文当前组选项命中任意段位即可通过，其他段位不直接导致失败", () => {
    const result = detectBodyProductStages(
      "宝宝现在喝3段，也回顾过2段时期的体验。",
      "GUM",
    );
    expect(result?.passed).toBe(true);
    expect(result?.matchedAllowedStages).toContain("3段");
    expect(result?.detectedStages).toContain("2段");
  });

  it("正文只出现其他组段位时返回OUTSIDE_GROUP", () => {
    const result = detectBodyProductStages(
      "这次记录宝宝喝2段奶粉的体验。",
      "GUM",
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
      "IFFO",
    );
    expect(result?.status).toBe("MISSING");
    expect(result?.passed).toBe(false);
  });

});
