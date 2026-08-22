import type { ExtractedNote, ExtractedTopic } from "@/lib/types";
import {
  douyinTopicMatchKey,
  normalizeDouyinTopicName,
} from "@/lib/douyin-topic";
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
  aliases: readonly StoreAliasConfig[];
  expectedTopic: string;
  acceptedTopics: readonly StoreAcceptedTopicConfig[];
  requiredTopics: readonly StoreAcceptedTopicConfig[];
  enabled: boolean;
}

export interface StoreAliasConfig {
  id: string;
  alias: string;
  normalizedAlias: string;
  enabled: boolean;
}

export interface StoreAcceptedTopicConfig {
  id: string;
  topic: string;
  normalizedTopic: string;
  sortOrder: number;
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

export function storeTopicWithHash(value: unknown) {
  const text = exactStoreTopicText(value);
  return text ? `#${text}` : "";
}

export function exactStoreTopicText(value: unknown) {
  const trimmed = String(value ?? "").trim();
  return trimmed.startsWith("#") ? trimmed.slice(1).trim() : trimmed;
}

export function normalizeStoreTopicForMatch(value: unknown) {
  return normalizeStoreNameForMatch(exactStoreTopicText(value));
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
  expectedTopics: string[];
  requiredTopics: string[];
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
      expectedTopics: [],
      requiredTopics: [],
      config: null,
      failureReason: "导入数据未填写店铺名称。",
    };
  }
  const normalizedStoreName = normalizeStoreNameForMatch(storeName);
  const directMatches = configs.filter(
    (item) =>
      item.enabled &&
      item.commercePlatform === commercePlatform &&
      item.normalizedStoreName === normalizedStoreName,
  );
  const aliasMatches = configs.filter(
    (item) =>
      item.enabled &&
      item.commercePlatform === commercePlatform &&
      item.aliases.some(
        (alias) =>
          alias.enabled && alias.normalizedAlias === normalizedStoreName,
      ),
  );
  const matches = directMatches.length ? directMatches : aliasMatches;
  if (matches.length !== 1) {
    const aliasCollision = directMatches.length === 0 && aliasMatches.length > 1;
    return {
      status: "STORE_NOT_MAPPED",
      storeTopicRuleId: null,
      storeName,
      matchedStoreName: null,
      commercePlatform,
      expectedTopic: null,
      expectedTopics: [],
      requiredTopics: [],
      config: null,
      failureReason: aliasCollision
        ? `STORE_ALIAS_COLLISION：同一平台下的店铺别名指向多个标准店铺，已拒绝匹配：${storeName}。`
        : commercePlatform
          ? `未在${commercePlatform === "JD" ? "京东" : commercePlatform === "TMALL" ? "天猫" : commercePlatform === "TAOBAO" ? "淘宝" : "抖音电商"}店铺话题规则中找到匹配店铺：${storeName}。`
        : `未找到有效成交平台，无法匹配店铺：${storeName}。`,
    };
  }
  const expectedTopics = matches[0].acceptedTopics
    .filter((topic) => topic.enabled)
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((topic) => storeTopicWithHash(topic.topic))
    .filter(Boolean);
  const requiredTopics = matches[0].requiredTopics
    .filter((topic) => topic.enabled)
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((topic) => storeTopicWithHash(topic.topic))
    .filter(Boolean);
  const compatibleExpectedTopic =
    expectedTopics[0] || storeTopicWithHash(matches[0].expectedTopic);
  return {
    status: "MATCHED",
    storeTopicRuleId: matches[0].id,
    storeName,
    matchedStoreName: matches[0].storeName,
    commercePlatform: matches[0].commercePlatform,
    expectedTopic: compatibleExpectedTopic || null,
    expectedTopics: expectedTopics.length
      ? expectedTopics
      : compatibleExpectedTopic
        ? [compatibleExpectedTopic]
        : [],
    requiredTopics,
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
  expectedTopics: string[];
  requiredTopics: string[];
  matchedTopic: string | null;
  matchedTopics: string[];
  matchedRequiredTopics: string[];
  failureReason: string | null;
  needsReview: boolean;
}

export function validateStoreTopic(input: {
  channel?: unknown;
  storeName?: unknown;
  expectedTopic?: unknown;
  expectedTopics?: unknown;
  requiredTopics?: unknown;
  mappingStatus?: unknown;
  extractedTopics: ExtractedTopic[];
  body?: unknown;
  pageUrl?: string | null;
}): StoreTopicAuditResult {
  const channel = parseContentChannel(input.channel);
  const topicWithHashForChannel = (value: unknown) =>
    channel === "DOUYIN"
      ? normalizeDouyinTopicName(value)
      : storeTopicWithHash(value);
  const topicMatchKeyForChannel = (value: unknown) =>
    channel === "DOUYIN"
      ? douyinTopicMatchKey(value)
      : normalizeStoreTopicForMatch(value);
  const normalizedTopicList = (values: unknown[]) => [
    ...new Map(
      values
        .map(topicWithHashForChannel)
        .filter(Boolean)
        .map((topic) => [topicMatchKeyForChannel(topic), topic] as const),
    ).values(),
  ];
  const expectedTopics = normalizedTopicList([
    ...(Array.isArray(input.expectedTopics) ? input.expectedTopics : []),
    input.expectedTopic,
  ]);
  const configuredRequiredTopics = normalizedTopicList(
    Array.isArray(input.requiredTopics) ? input.requiredTopics : [],
  );
  // Store mappings are shared across content channels. Xiaohongshu consumes
  // ACCEPTED (OR) + REQUIRED (AND), while Douyin intentionally consumes only
  // ACCEPTED (OR). Keep REQUIRED entries in storage, but do not expose them as
  // an active Douyin audit requirement.
  const requiredTopics = channel === "XIAOHONGSHU"
    ? configuredRequiredTopics
    : [];
  const expectedTopic = expectedTopics[0] || null;
  const mappingStatus = String(input.mappingStatus ?? "");
  const emptyResult = {
    expectedTopic: null,
    expectedTopics: [] as string[],
    requiredTopics: [] as string[],
    matchedTopic: null,
    matchedTopics: [] as string[],
    matchedRequiredTopics: [] as string[],
  };
  if (mappingStatus === "STORE_NAME_MISSING") {
    return {
      status: "UNREVIEWABLE",
      ...emptyResult,
      failureReason: "导入数据未填写店铺名称，店铺话题无法审核。",
      needsReview: true,
    };
  }
  if (mappingStatus !== "MATCHED" || !expectedTopics.length) {
    return {
      status: "UNREVIEWABLE",
      ...emptyResult,
      failureReason: "导入店铺名称未匹配店铺话题配置。",
      needsReview: true,
    };
  }
  if (!channel) {
    return {
      status: "UNREVIEWABLE",
      expectedTopic,
      expectedTopics,
      requiredTopics,
      matchedTopic: null,
      matchedTopics: [],
      matchedRequiredTopics: [],
      failureReason: "当前内容渠道尚未配置店铺话题审核适配器。",
      needsReview: true,
    };
  }
  const normalizedBody = normalizeStoreNameForMatch(input.body);
  const matchesFor = (configuredTopic: string) =>
    input.extractedTopics.filter(
      (topic) =>
        topicMatchKeyForChannel(topic.displayText) ===
        topicMatchKeyForChannel(configuredTopic),
    );
  const clickableMatchesFor = (configuredTopic: string) =>
    matchesFor(configuredTopic).filter(
      (topic) =>
        classifyTopicCandidates([topic], {
          pageUrl: input.pageUrl || undefined,
        }) === "CLICKABLE",
    );
  const matchedTopics = normalizedTopicList(
    expectedTopics.flatMap((topic) =>
      clickableMatchesFor(topic).map((candidate) => candidate.displayText),
    ),
  );
  const matchedTopic = matchedTopics[0] || null;
  const hardFailures: string[] = [];
  const reviewFailures: string[] = [];

  if (!matchedTopics.length) {
    const exactAcceptedMatches = expectedTopics.flatMap(matchesFor);
    if (!exactAcceptedMatches.length) {
      const onlyInBody = expectedTopics.some((topic) =>
        normalizedBody.includes(topicMatchKeyForChannel(topic).replace(/^#/u, "")),
      );
      hardFailures.push(
        onlyInBody
          ? `可接受店铺话题仅出现在正文中，未形成可点击话题：${expectedTopics.join("；")}`
          : `未命中任何可接受店铺话题：${expectedTopics.join("；")}`,
      );
    } else if (
      classifyTopicCandidates(exactAcceptedMatches, {
        pageUrl: input.pageUrl || undefined,
      }) === "UNKNOWN"
    ) {
      reviewFailures.push(
        `可接受店铺话题可点击状态无法确认：${normalizedTopicList(exactAcceptedMatches.map((topic) => topic.displayText)).join("；")}`,
      );
    } else {
      hardFailures.push(
        `可接受店铺话题不可点击：${normalizedTopicList(exactAcceptedMatches.map((topic) => topic.displayText)).join("；")}`,
      );
    }
  }

  const matchedRequiredTopics: string[] = [];
  for (const requiredTopic of requiredTopics) {
    const exactMatches = matchesFor(requiredTopic);
    const clickableMatches = clickableMatchesFor(requiredTopic);
    if (clickableMatches.length) {
      matchedRequiredTopics.push(
        topicWithHashForChannel(clickableMatches[0].displayText),
      );
      continue;
    }
    if (!exactMatches.length) {
      hardFailures.push(
        normalizedBody.includes(topicMatchKeyForChannel(requiredTopic).replace(/^#/u, ""))
          ? `附加必需话题仅出现在正文中，未形成可点击话题：${requiredTopic}`
          : `缺少附加必需话题：${requiredTopic}`,
      );
    } else if (
      classifyTopicCandidates(exactMatches, {
        pageUrl: input.pageUrl || undefined,
      }) === "UNKNOWN"
    ) {
      reviewFailures.push(`附加必需话题可点击状态无法确认：${requiredTopic}`);
    } else {
      hardFailures.push(`附加必需话题不可点击：${requiredTopic}`);
    }
  }

  const failureReason = [...hardFailures, ...reviewFailures].join("；") || null;
  if (hardFailures.length) {
    return {
      status: "NON_COMPLIANT",
      expectedTopic,
      expectedTopics,
      requiredTopics,
      matchedTopic,
      matchedTopics,
      matchedRequiredTopics,
      failureReason,
      needsReview: false,
    };
  }
  if (reviewFailures.length) {
    return {
      status: "UNREVIEWABLE",
      expectedTopic,
      expectedTopics,
      requiredTopics,
      matchedTopic,
      matchedTopics,
      matchedRequiredTopics,
      failureReason,
      needsReview: true,
    };
  }
  return {
    status: "COMPLIANT",
    expectedTopic,
    expectedTopics,
    requiredTopics,
    matchedTopic,
    matchedTopics,
    matchedRequiredTopics,
    failureReason: null,
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
    expectedTopics: resolved.expectedTopics,
    requiredTopics: resolved.requiredTopics,
    mappingStatus: resolved.status,
  };
}

export function storeTopicAuditForNote(
  note: Pick<ExtractedNote, "topics" | "body" | "url" | "finalUrl">,
  requirement: ReturnType<typeof buildStoreTopicAuditRequirement>,
) {
  if (!requirement) {
    return {
      status: "NOT_REQUIRED",
      expectedTopic: null,
      expectedTopics: [],
      requiredTopics: [],
      matchedTopic: null,
      matchedTopics: [],
      matchedRequiredTopics: [],
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
