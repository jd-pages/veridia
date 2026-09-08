import type { AuditContext, AuditRule, ExtractedNote, ExtractedTopic } from "@/lib/types";

export const topicBoundaryChannels = ["XIAOHONGSHU", "DOUYIN"] as const;
export type TopicBoundaryChannel = typeof topicBoundaryChannels[number];
export type TopicBoundaryClickability = "CLICKABLE" | "NOT_CLICKABLE" | "UNKNOWN";

export function boundaryTopic(
  channel: TopicBoundaryChannel,
  displayText: string,
  clickability: TopicBoundaryClickability = "CLICKABLE",
): ExtractedTopic {
  const clickable = clickability === "CLICKABLE";
  return {
    displayText,
    isClickable: clickable,
    isLinkElement: clickable,
    hasHref: clickable,
    href: clickable ? `https://www.${channel === "DOUYIN" ? "douyin" : "xiaohongshu"}.com/search?keyword=${encodeURIComponent(displayText)}` : null,
    styleFeature: clickable,
    domPath: clickability === "NOT_CLICKABLE" ? "#current-detail span.topic" : null,
    source: channel === "DOUYIN" ? "STRUCTURED_RESPONSE" : "STRUCTURED_PLATFORM_TOPIC",
  };
}

export function plainBoundaryTopic(displayText: string, rawText?: string): ExtractedTopic {
  return { displayText, rawText, isClickable: false, isLinkElement: false, hasHref: false,
    href: null, styleFeature: false, source: "BODY_TEXT_HASHTAG_CANDIDATE", domPath: "#current-detail span.plain" };
}

export function boundaryRule(topic: string, overrides: Partial<AuditRule> = {}): AuditRule {
  return { id: topic, scope: "CAMPAIGN", ruleType: "REQUIRED", topic,
    exactMatch: true, clickableRequired: false, caseSensitive: false, minCount: 1,
    sortOrder: 0, version: 1, ...overrides };
}

export function boundaryContext(channel: TopicBoundaryChannel, overrides: Partial<AuditContext> = {}): AuditContext {
  return { productId: "boundary-product", campaignId: "boundary-campaign", campaignName: "合成边界活动",
    contentChannel: channel, rulesConfigured: true, ruleVersion: 1,
    bodyRequired: true, minBodyLength: 21, minImageCount: 2, publicRequired: false,
    retentionDays: 0, clickableTopicRequired: true, rules: [boundaryRule("#required")], ...overrides };
}

export function boundaryNote(channel: TopicBoundaryChannel, overrides: Partial<ExtractedNote> = {}): ExtractedNote {
  const url = channel === "DOUYIN" ? "https://www.douyin.com/note/1234567890123456789" : "https://www.xiaohongshu.com/explore/123456789012345678901234";
  const topics = [boundaryTopic(channel, "#required")];
  return { url, finalUrl: url, contentChannel: channel,
    body: "真".repeat(21), pageStatus: "NORMAL", noteType: "IMAGE_TEXT", imageCount: 2,
    imageExtractionStatus: "SUCCESS", isPublic: true, topics,
    ...(channel === "DOUYIN" ? { verifiedDouyinTopics: topics } : { verifiedPlatformTopics: topics }),
    topicEvidenceCollected: true, extractedAt: new Date().toISOString(),
    adapterName: "synthetic-topic-boundary", adapterVersion: "1.0.0", ...overrides };
}
