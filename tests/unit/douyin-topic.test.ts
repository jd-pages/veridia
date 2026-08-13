import { describe, expect, it } from "vitest";
import { evaluateAudit } from "@/lib/audit-engine";
import {
  compareDouyinTopicNames,
  normalizeDouyinTopicName,
} from "@/lib/douyin-topic";
import { validateStoreTopic } from "@/lib/store-topic-config";
import type {
  AuditContext,
  ExtractedNote,
  ExtractedTopic,
} from "@/lib/types";

function verifiedTopic(
  displayText: string,
  source = "DOM",
): ExtractedTopic {
  return {
    displayText,
    isClickable: true,
    isLinkElement: source === "DOM",
    hasHref: true,
    href: `https://www.douyin.com/search/${encodeURIComponent(displayText)}`,
    styleFeature: true,
    domPath: source === "DOM" ? "a[data-douyin-topic]" : "structured:text_extra",
    source,
  };
}

function noteWithTopics(topics: ExtractedTopic[]): ExtractedNote {
  return {
    url: "https://www.douyin.com/video/123456789",
    finalUrl: "https://www.douyin.com/video/123456789",
    noteId: "123456789",
    title: "抖音话题测试",
    body: "这是一段满足审核要求的抖音作品正文。",
    noteType: "VIDEO",
    imageExtractionStatus: "VIDEO_NOTE",
    imageCount: 0,
    topics,
    verifiedDouyinTopics: topics,
    pageStatus: "NORMAL",
    isPublic: null,
    extractedAt: new Date().toISOString(),
    adapterName: "playwright-douyin",
    adapterVersion: "test",
  };
}

function contextForTopic(
  topic: string,
  overrides: Partial<AuditContext> = {},
): AuditContext {
  return {
    productId: "product",
    campaignId: "campaign",
    campaignName: "抖音话题测试活动",
    contentChannel: "DOUYIN",
    rulesConfigured: true,
    ruleVersion: 1,
    bodyRequired: false,
    minBodyLength: 0,
    minImageCount: 0,
    publicRequired: false,
    retentionDays: 0,
    clickableTopicRequired: true,
    rules: [{
      id: "required-topic",
      scope: "CAMPAIGN",
      ruleType: "REQUIRED",
      topic,
      exactMatch: true,
      clickableRequired: true,
      caseSensitive: false,
      minCount: 1,
      sortOrder: 0,
      version: 1,
      topicCategory: "CAMPAIGN",
    }],
    ...overrides,
  };
}

describe("Douyin 话题标准化与平台证据", () => {
  it.each([
    "A",
    "#A",
    "##A##",
    "  #A#  ",
    "#\u200bA\ufeff#",
  ])("将 %s 统一标准化为单前导井号", (value) => {
    expect(normalizeDouyinTopicName(value)).toBe("#A");
    expect(compareDouyinTopicNames(value, "#A")).toBe(true);
  });

  it.each(["#A", "#A#", "##A##", "#\u200bA\ufeff#"])(
    "真实平台话题 %s 精确命中 REQUIRED #A",
    (actual) => {
      const result = evaluateAudit(
        noteWithTopics([verifiedTopic(actual)]),
        contextForTopic("#A"),
      );
      expect(result.missingTopics).toEqual([]);
      expect(result.autoStatus).toBe("PASSED");
    },
  );

  it("不会把 #AB 当成 #A", () => {
    const result = evaluateAudit(
      noteWithTopics([verifiedTopic("#AB")]),
      contextForTopic("#A"),
    );
    expect(result.missingTopics).toContain("#A");
    expect(result.autoStatus).toBe("FAILED");
  });

  it("正文纯文本 #A 没有平台证据时仍然失败", () => {
    const note = noteWithTopics([]);
    note.body = "正文只写了 #A，但不是平台话题。";
    note.topics = [{
      displayText: "#A",
      isClickable: false,
      isLinkElement: false,
      hasHref: false,
      href: null,
      styleFeature: false,
      source: "BODY_TEXT_HASHTAG_CANDIDATE",
    }];
    note.bodyTextHashtagCandidates = note.topics;
    note.verifiedDouyinTopics = [];
    const result = evaluateAudit(note, contextForTopic("#A"));
    expect(result.missingTopics).toContain("#A");
    expect(result.autoStatus).toBe("FAILED");
  });

  it("阶段话题尾部多余井号仍正常命中", () => {
    const context = contextForTopic("#二段奶粉推荐", {
      productStage: "IFFO_2",
      bodyStageRequired: false,
    });
    context.rules[0] = {
      ...context.rules[0],
      topicCategory: "PRODUCT_STAGE",
      applicableStage: "IFFO_2",
    };
    const result = evaluateAudit(
      noteWithTopics([verifiedTopic("##二段奶粉推荐##")]),
      context,
    );
    expect(result.autoStatus).toBe("PASSED");
    expect(result.missingTopics).toEqual([]);
  });

  it("OR 话题组也使用同一标准化值", () => {
    const context = contextForTopic("#A");
    context.rules = ["#A", "#B"].map((topic, index) => ({
      ...context.rules[0],
      id: `any-${index}`,
      ruleType: "ANY",
      topic,
      minCount: 1,
    }));
    const result = evaluateAudit(
      noteWithTopics([verifiedTopic("#A##")]),
      context,
    );
    expect(result.autoStatus).toBe("PASSED");
  });

  it("真实结构化店铺话题带尾部井号时 ACCEPTED 通过", () => {
    const result = validateStoreTopic({
      channel: "DOUYIN",
      storeName: "爱他美优选海外专卖店",
      expectedTopics: ["#爱他美优选海外专卖店"],
      mappingStatus: "MATCHED",
      extractedTopics: [
        verifiedTopic(
          "#爱他美优选海外专卖店#",
          "STRUCTURED_RESPONSE",
        ),
      ],
    });
    expect(result.status).toBe("COMPLIANT");
    expect(result.matchedTopics).toEqual(["#爱他美优选海外专卖店"]);
  });

  it("店铺话题仅存在于正文时 ACCEPTED 仍失败", () => {
    const result = validateStoreTopic({
      channel: "DOUYIN",
      storeName: "爱他美优选海外专卖店",
      expectedTopics: ["#爱他美优选海外专卖店"],
      mappingStatus: "MATCHED",
      extractedTopics: [],
      body: "正文中写了 #爱他美优选海外专卖店，但没有平台话题证据。",
    });
    expect(result.status).toBe("NON_COMPLIANT");
    expect(result.failureReason).toContain("仅出现在正文中");
  });
});
