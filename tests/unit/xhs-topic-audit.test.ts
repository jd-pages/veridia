import { describe, expect, it } from "vitest";
import { countEffectiveBodyCharacters, evaluateAudit } from "@/lib/audit-engine";
import { createMockNote } from "@/lib/mock-data";
import type { AuditContext, ExtractedTopic } from "@/lib/types";

const plainTopic = (displayText: string): ExtractedTopic => ({
  displayText,
  isLinkElement: false,
  hasHref: false,
  href: null,
  textColor: null,
  styleFeature: false,
  domPath: null,
  source: "VISIBLE_TEXT",
});

const verifiedTopic = (displayText: string): ExtractedTopic => ({
  displayText,
  isClickable: true,
  isLinkElement: true,
  hasHref: true,
  href: `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(displayText)}`,
  textColor: "rgb(19, 119, 255)",
  styleFeature: true,
  domPath: "a.topic",
  source: "DOM_LINK",
});

const rule = (topic: string, index = 0) => ({
  id: `rule-${index}`,
  scope: "CAMPAIGN",
  ruleType: "MUST_ALL",
  topic,
  exactMatch: true,
  clickableRequired: true,
  caseSensitive: false,
  minCount: 1,
  sortOrder: index,
  version: 1,
});

const baseContext: AuditContext = {
  productId: "product",
  campaignId: "campaign",
  campaignName: "XHS 话题证据测试",
  contentChannel: "XIAOHONGSHU",
  rulesConfigured: true,
  ruleVersion: 1,
  bodyRequired: true,
  minBodyLength: 1,
  minImageCount: 0,
  publicRequired: false,
  retentionDays: 0,
  clickableTopicRequired: true,
  rules: [],
};

function noteWithEvidence(input: {
  body: string;
  text?: string[];
  verified?: string[];
}) {
  const note = createMockNote("passed");
  const textHashtagCandidates = (input.text || []).map(plainTopic);
  const verifiedPlatformTopics = (input.verified || []).map(verifiedTopic);
  note.body = input.body;
  note.textHashtagCandidates = textHashtagCandidates;
  note.verifiedPlatformTopics = verifiedPlatformTopics;
  note.topics = verifiedPlatformTopics;
  note.topicEvidenceCollected = true;
  note.technicalWarnings = [];
  return note;
}

describe("XHS 仅使用平台已验证话题审核", () => {
  it("正文纯文本匹配阶段话题仍判定未命中", () => {
    const topic = "#三段奶粉推荐";
    const result = evaluateAudit(
      noteWithEvidence({ body: `宝宝喝得不错 ${topic}`, text: [topic] }),
      {
        ...baseContext,
        productStage: "GUM_3_4_1PLUS_2PLUS",
        bodyStageRequired: false,
        rules: [{ ...rule(topic), topicCategory: "PRODUCT_STAGE", applicableStage: "GUM_3_4_1PLUS_2PLUS" }],
      },
    );
    expect(result.autoStatus).toBe("FAILED");
    expect(result.failureReasons.join("；")).toContain("阶段话题未命中");
  });

  it("纯文本 A 与可点击 B 时只允许 B 命中", () => {
    const note = noteWithEvidence({
      body: "正文 #A #B",
      text: ["#A", "#B"],
      verified: ["#B"],
    });
    expect(
      evaluateAudit(note, { ...baseContext, rules: [rule("#A")] }).autoStatus,
    ).toBe("FAILED");
    expect(
      evaluateAudit(note, { ...baseContext, rules: [rule("#B")] }).autoStatus,
    ).toBe("PASSED");
  });

  it("三个纯文本要求话题为 0/3，三个真实话题为 3/3", () => {
    const topics = ["#A", "#B", "#C"];
    const rules = topics.map(rule);
    const plainResult = evaluateAudit(
      noteWithEvidence({ body: `正文 ${topics.join(" ")}`, text: topics }),
      { ...baseContext, rules },
    );
    const verifiedResult = evaluateAudit(
      noteWithEvidence({
        body: `正文 ${topics.join(" ")}`,
        text: topics,
        verified: topics,
      }),
      { ...baseContext, rules },
    );
    const topicRuleResults = (result: typeof plainResult) =>
      result.ruleResults.filter((item) => item.ruleKey.startsWith("TOPIC_rule-"));
    expect(topicRuleResults(plainResult).filter((item) => item.passed)).toHaveLength(0);
    expect(topicRuleResults(verifiedResult).filter((item) => item.passed)).toHaveLength(3);
    expect(plainResult.autoStatus).toBe("FAILED");
    expect(verifiedResult.autoStatus).toBe("PASSED");
  });

  it("店铺话题纯文本失败，真实可点击话题通过", () => {
    const storeTopic = "#爱他美金胜海外专卖店";
    const context: AuditContext = {
      ...baseContext,
      rules: [],
      storeTopicRequirement: {
        channel: "XIAOHONGSHU",
        storeName: "爱他美金胜海外专卖店",
        storeTopicRuleId: "store-rule",
        matchedStoreName: "爱他美金胜海外专卖店",
        commercePlatform: "JD",
        expectedTopic: storeTopic,
        expectedTopics: [storeTopic],
        requiredTopics: [],
        mappingStatus: "MATCHED",
      },
    };
    const plain = evaluateAudit(
      noteWithEvidence({ body: `正文 ${storeTopic}`, text: [storeTopic] }),
      context,
    );
    const verified = evaluateAudit(
      noteWithEvidence({
        body: `正文 ${storeTopic}`,
        text: [storeTopic],
        verified: [storeTopic],
      }),
      context,
    );
    expect(plain.storeTopicStatus).toBe("NON_COMPLIANT");
    expect(verified.storeTopicStatus).toBe("COMPLIANT");
  });

  it("话题证据分层不改变正文有效字符数", () => {
    const body = "宝宝喝得不错 #三段奶粉推荐";
    const topic = "#三段奶粉推荐";
    const plain = evaluateAudit(
      noteWithEvidence({ body, text: [topic] }),
      { ...baseContext, rules: [] },
    );
    const verified = evaluateAudit(
      noteWithEvidence({ body, text: [topic], verified: [topic] }),
      { ...baseContext, rules: [] },
    );
    expect(plain.effectiveBodyLength).toBe(
      countEffectiveBodyCharacters(body, [topic]),
    );
    expect(verified.effectiveBodyLength).toBe(plain.effectiveBodyLength);
  });

  it("Douyin 继续使用其独立已验证话题结构", () => {
    const topic = "#抖音正文话题";
    const note = noteWithEvidence({ body: `抖音正文 ${topic}` });
    note.topics = [{
      ...verifiedTopic(topic),
      href: `https://www.douyin.com/search/${encodeURIComponent(topic)}`,
      domPath: "a[data-douyin-topic]",
      source: "DOM",
    }];
    note.verifiedDouyinTopics = note.topics;
    note.verifiedPlatformTopics = [];
    const result = evaluateAudit(note, {
      ...baseContext,
      contentChannel: "DOUYIN",
      clickableTopicRequired: false,
      rules: [{ ...rule(topic), clickableRequired: false }],
    });
    expect(result.autoStatus).toBe("PASSED");
  });
});
