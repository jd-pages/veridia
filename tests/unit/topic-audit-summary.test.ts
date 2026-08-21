import { describe, expect, it } from "vitest";
import { topicAuditRuleSummary } from "@/lib/topic-audit-summary";

function snapshot(
  rules: Array<{
    ruleType: string;
    topic: string;
    topicCategory?: string;
    minCount?: number;
  }>,
) {
  return JSON.stringify({ rules });
}

describe("历史审核结果话题分组展示", () => {
  it("EXACT 缺少 1 个必带话题", () => {
    const summary = topicAuditRuleSummary(
      snapshot([{ ruleType: "EXACT", topic: "#必带一" }]),
      [],
    );
    expect(summary.missingRequiredTopics).toEqual(["#必带一"]);
    expect(summary).toMatchObject({ expectedCount: 1, matchedCount: 0 });
  });

  it("EXACT 缺少多个必带话题", () => {
    const summary = topicAuditRuleSummary(
      snapshot([
        { ruleType: "EXACT", topic: "#必带一" },
        { ruleType: "REQUIRED", topic: "#必带二" },
      ]),
      [],
    );
    expect(summary.missingRequiredTopics).toEqual(["#必带一", "#必带二"]);
    expect(summary.expectedCount).toBe(2);
  });

  const popularRules = ["#热门一", "#热门二", "#热门三", "#热门四"].map(
    (topic) => ({ ruleType: "ANY", topic, minCount: 2 }),
  );

  it("ANY 4 选 2 命中 1 个时只显示还需任意 1 个", () => {
    const summary = topicAuditRuleSummary(
      snapshot(popularRules),
      ["#热门一"],
    );
    expect(summary).toMatchObject({
      anyMinimum: 2,
      matchedAnyCandidates: ["#热门一"],
      unmatchedAnyCandidates: ["#热门二", "#热门三", "#热门四"],
      anyMissingCount: 1,
      expectedCount: 2,
      matchedCount: 1,
    });
  });

  it("ANY 4 选 2 命中 2 个时满足分组要求", () => {
    const summary = topicAuditRuleSummary(
      snapshot(popularRules),
      ["#热门一", "#热门三"],
    );
    expect(summary).toMatchObject({
      anyMissingCount: 0,
      expectedCount: 2,
      matchedCount: 2,
    });
  });

  it("ANY 候选均未命中时按最低数量展示进度", () => {
    const summary = topicAuditRuleSummary(snapshot(popularRules), []);
    expect(summary).toMatchObject({
      anyMissingCount: 2,
      expectedCount: 2,
      matchedCount: 0,
    });
    expect(summary.unmatchedAnyCandidates).toHaveLength(4);
  });

  it("阶段话题候选按任意命中 1 个计数", () => {
    const rules = ["#阶段一", "#阶段二"].map((topic) => ({
      ruleType: "REQUIRED",
      topic,
      topicCategory: "PRODUCT_STAGE",
    }));
    expect(topicAuditRuleSummary(snapshot(rules), ["#阶段二"])).toMatchObject({
      stageGroupMissing: false,
      expectedCount: 1,
      matchedCount: 1,
      matchedStageCandidates: ["#阶段二"],
    });
  });

  it("混合 EXACT、ANY、阶段组时总数使用分组要求口径", () => {
    const summary = topicAuditRuleSummary(
      snapshot([
        { ruleType: "EXACT", topic: "#必带一" },
        { ruleType: "EXACT", topic: "#必带二" },
        ...popularRules,
        { ruleType: "REQUIRED", topic: "#阶段一", topicCategory: "PRODUCT_STAGE" },
        { ruleType: "REQUIRED", topic: "#阶段二", topicCategory: "PRODUCT_STAGE" },
      ]),
      ["#必带一", "#必带二", "#热门一", "#阶段二"],
    );
    expect(summary).toMatchObject({
      expectedCount: 5,
      matchedCount: 4,
      anyMissingCount: 1,
      stageGroupMissing: false,
    });
  });

  it("历史结果只使用保存的 ruleSnapshot，不读取后来新增的话题规则", () => {
    const historical = topicAuditRuleSummary(
      snapshot([{ ruleType: "EXACT", topic: "#历史必带" }]),
      ["#当前新增规则"],
    );
    expect(historical.requiredTopics).toEqual(["#历史必带"]);
    expect(historical.missingRequiredTopics).toEqual(["#历史必带"]);
    expect(historical.expectedCount).toBe(1);
  });
});
