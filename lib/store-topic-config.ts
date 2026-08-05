import type { ExtractedNote, ExtractedTopic } from "@/lib/types";
import { classifyTopicCandidates } from "@/lib/topic-clickability";
import {
  parseCommercePlatform,
  parseContentChannel,
  type CommercePlatform,
} from "@/lib/result-source";

export interface StoreTopicConfig {
  commercePlatform: CommercePlatform;
  storeName: string;
  expectedTopic: string;
  enabled: boolean;
}

const storesByPlatform: Record<CommercePlatform, readonly string[]> = {
  JD: [
    "爱他美优选海外专卖店", "爱他美国际进口超市", "Aptamil爱他美海外进口超市",
    "爱他美精选海外专卖店", "爱他美海外京东自营专区", "FOLO海外官方旗舰店",
    "国际平价会员店", "环球甄选旗舰店", "海星健康官方进口超市",
    "京东全球购母婴直营店", "佳贝艾特(Kabrita)海外专卖店",
    "佳贝艾特海外京东自营旗舰店", "佳贝艾特官方海外旗舰店",
    "佳贝艾特(Kabrita)海外旗舰店", "a2海外专卖店", "美素佳儿海外专卖店",
    "雀巢母婴海外专卖店", "贝拉米海外专卖店", "惠氏(Wyeth)海外专卖店",
    "健康官方进口超市", "京东健康官方进口超市", "荷兰官方进口国家馆",
    "德国官方进口国家馆", "澳大利亚官方进口国家馆", "医学营养京东自营旗舰店",
    "京东健康海外自营旗舰店", "京东健康全球探物",
  ],
  DOUYIN_ECOMMERCE: [
    "ROCKCHECK海外专营店", "FOLO海外旗舰店", "佳贝艾特kabrita海外旗舰店",
    "Bellamy's贝拉米荣程海外专卖店",
  ],
  TMALL: [
    "folo海外专营店", "AYW海外专营店", "BJF海外专营店", "贝拉米海星海外专卖店",
    "kabrita海外旗舰店", "kabrita母婴海外旗舰店", "a2金胜海外专卖店",
    "a2海星海外专卖店", "爱他美金胜海外专卖店",
  ],
  TAOBAO: ["ALG阿莱购", "国际进口超市"],
};

export const storeTopicConfigs: readonly StoreTopicConfig[] = Object.entries(
  storesByPlatform,
).flatMap(([commercePlatform, stores]) =>
  stores.map((storeName) => ({
    commercePlatform: commercePlatform as CommercePlatform,
    storeName,
    expectedTopic: storeName,
    enabled: true,
  })),
);

export type StoreMappingStatus =
  | "MATCHED"
  | "STORE_NAME_MISSING"
  | "STORE_NOT_MAPPED";

export interface StoreTopicResolution {
  status: StoreMappingStatus;
  storeName: string | null;
  commercePlatform: CommercePlatform | null;
  expectedTopic: string | null;
  config: StoreTopicConfig | null;
  failureReason: string | null;
}

export function resolveStoreTopicConfig(input: {
  storeName?: unknown;
  commercePlatform?: unknown;
}): StoreTopicResolution {
  const storeName = String(input.storeName ?? "").trim();
  if (!storeName) {
    return {
      status: "STORE_NAME_MISSING",
      storeName: null,
      commercePlatform: parseCommercePlatform(input.commercePlatform),
      expectedTopic: null,
      config: null,
      failureReason: "导入数据未填写店铺名称。",
    };
  }
  const rawPlatform = String(input.commercePlatform ?? "").trim();
  const commercePlatform = parseCommercePlatform(rawPlatform);
  const matches = storeTopicConfigs.filter(
    (item) =>
      item.enabled &&
      item.storeName === storeName &&
      (!rawPlatform || item.commercePlatform === commercePlatform),
  );
  if (matches.length !== 1) {
    return {
      status: "STORE_NOT_MAPPED",
      storeName,
      commercePlatform,
      expectedTopic: null,
      config: null,
      failureReason: "导入店铺名称未在店铺话题配置中找到完全一致的记录。",
    };
  }
  return {
    status: "MATCHED",
    storeName,
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

export function validateStoreTopic(input: {
  channel?: unknown;
  storeName?: unknown;
  expectedTopic?: unknown;
  mappingStatus?: unknown;
  extractedTopics: ExtractedTopic[];
  body?: unknown;
  pageUrl?: string | null;
}): StoreTopicAuditResult {
  const expectedTopic = String(input.expectedTopic ?? "").trim();
  const mappingStatus = String(input.mappingStatus ?? "");
  if (mappingStatus === "STORE_NAME_MISSING") {
    return {
      status: "UNREVIEWABLE", expectedTopic: null, matchedTopic: null,
      failureReason: "导入数据未填写店铺名称，店铺话题无法审核。", needsReview: true,
    };
  }
  if (mappingStatus !== "MATCHED" || !expectedTopic) {
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
    (topic) => exactTopicText(topic.displayText) === expectedTopic,
  );
  if (!exactMatches.length) {
    const onlyInBody = String(input.body ?? "").includes(expectedTopic);
    return {
      status: "NON_COMPLIANT", expectedTopic, matchedTopic: null,
      failureReason: onlyInBody
        ? `店铺名称仅出现在正文中，未形成可点击话题：#${expectedTopic}`
        : `缺少店铺话题：#${expectedTopic}`,
      needsReview: false,
    };
  }
  const clickability = classifyTopicCandidates(exactMatches, {
    pageUrl: input.pageUrl || undefined,
  });
  const matchedTopic = `#${expectedTopic}`;
  if (clickability === "CLICKABLE") {
    return {
      status: "COMPLIANT", expectedTopic, matchedTopic,
      failureReason: null, needsReview: false,
    };
  }
  if (clickability === "UNKNOWN") {
    return {
      status: "UNREVIEWABLE", expectedTopic, matchedTopic,
      failureReason: `店铺话题可点击状态无法确认：#${expectedTopic}`,
      needsReview: true,
    };
  }
  return {
    status: "NON_COMPLIANT", expectedTopic, matchedTopic,
    failureReason: `店铺话题不可点击：#${expectedTopic}`,
    needsReview: false,
  };
}

export function resolveStoreTopicAuditRequirement(input: {
  source?: unknown;
  channel?: unknown;
  platform?: unknown;
  storeName?: unknown;
  commercePlatform?: unknown;
  expectedStoreTopic?: unknown;
  storeMappingStatus?: unknown;
}) {
  if (String(input.source ?? "") !== "EXCEL") return null;
  const resolved = resolveStoreTopicConfig({
    storeName: input.storeName,
    commercePlatform: input.commercePlatform,
  });
  return {
    channel:
      parseContentChannel(input.channel) || parseContentChannel(input.platform),
    storeName: resolved.storeName,
    commercePlatform:
      parseCommercePlatform(input.commercePlatform) || resolved.commercePlatform,
    expectedTopic:
      String(input.expectedStoreTopic ?? "").trim() || resolved.expectedTopic,
    mappingStatus:
      String(input.storeMappingStatus ?? "").trim() || resolved.status,
  };
}

export function storeTopicAuditForNote(
  note: Pick<ExtractedNote, "topics" | "body" | "url" | "finalUrl">,
  requirement: ReturnType<typeof resolveStoreTopicAuditRequirement>,
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
