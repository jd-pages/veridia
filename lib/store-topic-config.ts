import type { ExtractedNote, ExtractedTopic } from "@/lib/types";
import { classifyTopicCandidates } from "@/lib/topic-clickability";
import {
  parseCommercePlatform,
  parseContentChannel,
  type CommercePlatform,
} from "@/lib/result-source";

export interface StoreTopicConfig {
  id: string;
  commercePlatform: CommercePlatform;
  storeName: string;
  normalizedStoreName: string;
  expectedTopic: string;
  enabled: boolean;
}

export function normalizeStoreNameForMatch(value: unknown) {
  return String(value ?? "")
    .trim()
    .replace(/[A-Z]/g, (character) => character.toLowerCase());
}

export function expectedStoreTopicForName(storeName: unknown) {
  const normalized = String(storeName ?? "").trim();
  return normalized ? `#${normalized}` : "";
}

export type StoreMappingStatus =
  | "MATCHED"
  | "STORE_NAME_MISSING"
  | "STORE_NOT_MAPPED";

export interface StoreTopicResolution {
  status: StoreMappingStatus;
  storeTopicRuleId: string | null;
  storeName: string | null;
  matchedStoreName: string | null;
  commercePlatform: CommercePlatform | null;
  expectedTopic: string | null;
  config: StoreTopicConfig | null;
  failureReason: string | null;
}

export function resolveStoreTopicConfig(
  configs: readonly StoreTopicConfig[],
  input: { storeName?: unknown; commercePlatform?: unknown },
): StoreTopicResolution {
  const storeName = String(input.storeName ?? "").trim();
  const commercePlatform = parseCommercePlatform(input.commercePlatform);
  if (!storeName) {
    return {
      status: "STORE_NAME_MISSING",
      storeTopicRuleId: null,
      storeName: null,
      matchedStoreName: null,
      commercePlatform,
      expectedTopic: null,
      config: null,
      failureReason: "导入数据未填写店铺名称。",
    };
  }
  const normalizedStoreName = normalizeStoreNameForMatch(storeName);
  const matches = configs.filter(
    (item) =>
      item.enabled &&
      item.commercePlatform === commercePlatform &&
      item.normalizedStoreName === normalizedStoreName,
  );
  if (matches.length !== 1) {
    return {
      status: "STORE_NOT_MAPPED",
      storeTopicRuleId: null,
      storeName,
      matchedStoreName: null,
      commercePlatform,
      expectedTopic: null,
      config: null,
      failureReason: commercePlatform
        ? `未在${commercePlatform === "JD" ? "京东" : commercePlatform === "TMALL" ? "天猫" : commercePlatform === "TAOBAO" ? "淘宝" : "抖音电商"}店铺话题规则中找到匹配店铺：${storeName}。`
        : `未找到有效成交平台，无法匹配店铺：${storeName}。`,
    };
  }
  return {
    status: "MATCHED",
    storeTopicRuleId: matches[0].id,
    storeName,
    matchedStoreName: matches[0].storeName,
    commercePlatform: matches[0].commercePlatform,
    expectedTopic: matches[0].expectedTopic,
    config: matches[0],
    failureReason: null,
  };
}

export type StoreTopicAuditStatus =
  | "NOT_REQUIRED"
  | "NOT_CHECKED"
  | "COMPLIANT"
  | "NON_COMPLIANT"
  | "UNREVIEWABLE";

export interface StoreTopicAuditResult {
  status: StoreTopicAuditStatus;
  expectedTopic: string | null;
  matchedTopic: string | null;
  failureReason: string | null;
  needsReview: boolean;
}

function exactTopicText(value: unknown) {
  const trimmed = String(value ?? "").trim();
  return trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
}

function topicWithHash(value: unknown) {
  const text = exactTopicText(value);
  return text ? `#${text}` : "";
}

export function validateStoreTopic(input: {
  channel?: unknown;
  storeName?: unknown;
  expectedTopic?: unknown;
  mappingStatus?: unknown;
  extractedTopics: ExtractedTopic[];
  body?: unknown;
  pageUrl?: string | null;
}): StoreTopicAuditResult {
  const expectedTopic = topicWithHash(input.expectedTopic);
  const expectedTopicText = exactTopicText(expectedTopic);
  const mappingStatus = String(input.mappingStatus ?? "");
  if (mappingStatus === "STORE_NAME_MISSING") {
    return {
      status: "UNREVIEWABLE", expectedTopic: null, matchedTopic: null,
      failureReason: "导入数据未填写店铺名称，店铺话题无法审核。", needsReview: true,
    };
  }
  if (mappingStatus !== "MATCHED" || !expectedTopicText) {
    return {
      status: "UNREVIEWABLE", expectedTopic: null, matchedTopic: null,
      failureReason: "导入店铺名称未匹配店铺话题配置。", needsReview: true,
    };
  }
  const channel = parseContentChannel(input.channel);
  if (channel !== "XIAOHONGSHU") {
    return {
      status: "UNREVIEWABLE", expectedTopic, matchedTopic: null,
      failureReason: "当前内容渠道尚未配置店铺话题审核适配器。", needsReview: true,
    };
  }
  const exactMatches = input.extractedTopics.filter(
    (topic) =>
      normalizeStoreNameForMatch(exactTopicText(topic.displayText)) ===
      normalizeStoreNameForMatch(expectedTopicText),
  );
  if (!exactMatches.length) {
    const onlyInBody = normalizeStoreNameForMatch(input.body).includes(
      normalizeStoreNameForMatch(expectedTopicText),
    );
    return {
      status: "NON_COMPLIANT", expectedTopic, matchedTopic: null,
      failureReason: onlyInBody
        ? `店铺名称仅出现在正文中，未形成可点击话题：${expectedTopic}`
        : `缺少店铺话题：${expectedTopic}`,
      needsReview: false,
    };
  }
  const clickability = classifyTopicCandidates(exactMatches, {
    pageUrl: input.pageUrl || undefined,
  });
  const matchedTopic = topicWithHash(exactMatches[0].displayText);
  if (clickability === "CLICKABLE") {
    return {
      status: "COMPLIANT", expectedTopic, matchedTopic,
      failureReason: null, needsReview: false,
    };
  }
  if (clickability === "UNKNOWN") {
    return {
      status: "UNREVIEWABLE", expectedTopic, matchedTopic,
      failureReason: `店铺话题可点击状态无法确认：${expectedTopic}`,
      needsReview: true,
    };
  }
  return {
    status: "NON_COMPLIANT", expectedTopic, matchedTopic,
    failureReason: `店铺话题不可点击：${expectedTopic}`,
    needsReview: false,
  };
}

export function buildStoreTopicAuditRequirement(input: {
  source?: unknown;
  channel?: unknown;
  platform?: unknown;
  storeName?: unknown;
  commercePlatform?: unknown;
  expectedStoreTopic?: unknown;
  storeMappingStatus?: unknown;
  resolved: StoreTopicResolution;
}) {
  if (
    String(input.source ?? "") !== "EXCEL" &&
    !String(input.storeName ?? "").trim() &&
    !String(input.expectedStoreTopic ?? "").trim()
  ) return null;
  const resolved = input.resolved;
  return {
    channel:
      parseContentChannel(input.channel) || parseContentChannel(input.platform),
    storeName: resolved.storeName,
    storeTopicRuleId: resolved.storeTopicRuleId,
    matchedStoreName: resolved.matchedStoreName,
    commercePlatform:
      parseCommercePlatform(input.commercePlatform) || resolved.commercePlatform,
    expectedTopic: resolved.expectedTopic,
    mappingStatus: resolved.status,
  };
}

export function storeTopicAuditForNote(
  note: Pick<ExtractedNote, "topics" | "body" | "url" | "finalUrl">,
  requirement: ReturnType<typeof buildStoreTopicAuditRequirement>,
) {
  if (!requirement) {
    return {
      status: "NOT_REQUIRED", expectedTopic: null, matchedTopic: null,
      failureReason: null, needsReview: false,
    } satisfies StoreTopicAuditResult;
  }
  return validateStoreTopic({
    ...requirement,
    extractedTopics: note.topics,
    body: note.body,
    pageUrl: note.finalUrl || note.url,
  });
}
