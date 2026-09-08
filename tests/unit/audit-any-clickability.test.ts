import { describe, expect, it } from "vitest";
import { evaluateAudit } from "@/lib/audit-engine";
import { boundaryContext, boundaryNote, boundaryRule, boundaryTopic, plainBoundaryTopic,
  topicBoundaryChannels, type TopicBoundaryChannel, type TopicBoundaryClickability } from "../helpers/audit-topic-boundary-fixture";

function evaluateAny(channel: TopicBoundaryChannel, states: TopicBoundaryClickability[], global: boolean, local: boolean, minCount = 1) {
  const topics = states.map((state, index) => boundaryTopic(channel, `#${String.fromCharCode(65 + index)}`, state));
  const result = evaluateAudit(boundaryNote(channel, { topics,
    ...(channel === "DOUYIN" ? { verifiedDouyinTopics: topics } : { verifiedPlatformTopics: topics }),
  }), boundaryContext(channel, { clickableTopicRequired: global,
    rules: ["#A", "#B", "#C"].map((topic) => boundaryRule(topic, { ruleType: "ANY", clickableRequired: local, minCount })),
  }));
  return { result, group: result.ruleResults.find((rule) => rule.ruleKey === "TOPIC_ANY_GROUP")! };
}

describe("ANY_TOPIC_RESPECTS_CAMPAIGN_CLICKABILITY", () => {
  it("ANY 全局或局部可点击要求只计明确匹配并保留 UNKNOWN 人工复核", () => {
    for (const channel of topicBoundaryChannels) {
      for (const [global, local] of [[true, false], [false, true], [true, true]]) {
        expect(evaluateAny(channel, ["NOT_CLICKABLE"], global, local).result.autoStatus).toBe("FAILED");
        expect(evaluateAny(channel, ["CLICKABLE"], global, local).result.autoStatus).toBe("PASSED");
        const unknown = evaluateAny(channel, ["UNKNOWN"], global, local);
        expect(unknown.result.autoStatus).toBe("NEEDS_REVIEW");
        expect(unknown.group.evidence).toMatchObject({ matchedCount: 0, pendingCount: 1, clickabilityNeedsReview: true });
      }
      for (const state of ["NOT_CLICKABLE", "UNKNOWN"] as const) {
        const optional = evaluateAny(channel, [state], false, false);
        expect(optional.result.autoStatus).toBe("PASSED");
        expect(optional.group.evidence).toMatchObject({ matchedCount: 1, pendingCount: 0 });
      }
    }
  });

  it.each([
    { states: ["CLICKABLE", "CLICKABLE", "NOT_CLICKABLE"], status: "PASSED", matched: 2, pending: 0 },
    { states: ["CLICKABLE", "CLICKABLE", "UNKNOWN"], status: "PASSED", matched: 2, pending: 1 },
    { states: ["CLICKABLE", "NOT_CLICKABLE"], status: "FAILED", matched: 1, pending: 0 },
    { states: ["CLICKABLE", "UNKNOWN"], status: "NEEDS_REVIEW", matched: 1, pending: 1 },
    { states: ["UNKNOWN", "UNKNOWN"], status: "NEEDS_REVIEW", matched: 0, pending: 2 },
    { states: ["UNKNOWN", "NOT_CLICKABLE"], status: "FAILED", matched: 0, pending: 1 },
  ])("minCount=2：$states 得到 $status，UNKNOWN 不占明确名额", ({ states, status, matched, pending }) => {
    for (const channel of topicBoundaryChannels) {
      const { result, group } = evaluateAny(channel, states as TopicBoundaryClickability[], true, false, 2);
      expect(result.autoStatus, channel).toBe(status);
      expect(group.evidence, channel).toMatchObject({ matchedCount: matched, pendingCount: pending, minCount: 2 });
      expect(group.passed, channel).toBe(status !== "FAILED");
      if (status === "PASSED") expect(result.clickableCompliant).toBe(true);
    }
  });

  it("REQUIRED、ANY 和 PRODUCT_STAGE 使用相同全局或局部要求与 UNKNOWN 状态", () => {
    for (const channel of topicBoundaryChannels) {
      for (const category of ["REQUIRED", "ANY", "PRODUCT_STAGE"]) {
        for (const [global, local] of [[true, false], [false, true], [false, false]]) {
          for (const state of ["CLICKABLE", "NOT_CLICKABLE", "UNKNOWN"] as const) {
            const topic = boundaryTopic(channel, "#A", state);
            const result = evaluateAudit(boundaryNote(channel, { topics: [topic],
              ...(channel === "DOUYIN" ? { verifiedDouyinTopics: [topic] } : { verifiedPlatformTopics: [topic] }),
            }), boundaryContext(channel, { clickableTopicRequired: global, productStage: "IFFO_2", bodyStageRequired: false,
              rules: [boundaryRule("#A", { ruleType: category === "ANY" ? "ANY" : "REQUIRED", clickableRequired: local,
                ...(category === "PRODUCT_STAGE" ? { topicCategory: "PRODUCT_STAGE", applicableStage: "IFFO_2" } : {}) })],
            }));
            const expected = !(global || local) || state === "CLICKABLE" ? "PASSED" : state === "UNKNOWN" ? "NEEDS_REVIEW" : "FAILED";
            expect(result.autoStatus, `${channel}/${category}/${global}/${local}/${state}`).toBe(expected);
          }
        }
      }
    }
  });

  it("普通文本不提升为 ANY 候选，禁止话题也不因不可点击而放过", () => {
    for (const channel of topicBoundaryChannels) {
      const plain = plainBoundaryTopic("#A");
      const plainResult = evaluateAudit(boundaryNote(channel, { topics: [plain],
        verifiedPlatformTopics: [], verifiedDouyinTopics: [], bodyTextHashtagCandidates: [plain],
      }), boundaryContext(channel, { clickableTopicRequired: false,
        rules: [boundaryRule("#A", { ruleType: "ANY", clickableRequired: false })],
      }));
      expect(plainResult.autoStatus).toBe("FAILED");
      const forbidden = boundaryTopic(channel, "#A", "NOT_CLICKABLE");
      const forbiddenResult = evaluateAudit(boundaryNote(channel, { topics: [forbidden],
        ...(channel === "DOUYIN" ? { verifiedDouyinTopics: [forbidden] } : { verifiedPlatformTopics: [forbidden] }),
      }), boundaryContext(channel, { rules: [boundaryRule("#A", { ruleType: "FORBIDDEN" })] }));
      expect(forbiddenResult.autoStatus).toBe("FAILED");
      expect(forbiddenResult.forbiddenTopics).toEqual(["#A"]);
    }
  });
});
