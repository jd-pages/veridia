import { describe, expect, it } from "vitest";
import { validateAcceptedStoreTopics, validateStoreTopicGroups } from "@/lib/store-topic-rule-service";
import {
  buildStoreTopicAuditRequirement, normalizeStoreNameForMatch,
  resolveStoreTopicConfig, storeTopicAuditForNote, type StoreTopicConfig,
} from "@/lib/store-topic-config";
import { scopeStoreTopicsByPolicy } from "@/lib/store-brand-topic-policy";

const identity: StoreTopicConfig = {
  id: "isolated-store", commercePlatform: "JD", storeName: "佳贝艾特普通店铺 A",
  normalizedStoreName: normalizeStoreNameForMatch("佳贝艾特普通店铺 A"), enabled: true,
  aliases: [{ id: "alias", alias: "上游普通店铺", normalizedAlias: "上游普通店铺", enabled: true }],
  expectedTopic: "", acceptedTopics: [], requiredTopics: [],
};
const topicEntry = (topic: string, sortOrder = 0) => ({ id: topic, topic, normalizedTopic: topic.slice(1), enabled: true, sortOrder });
const note = (topics: string[] = []) => ({
  topics: topics.map(displayText => ({ displayText, isLinkElement: true, hasHref: true,
    href: "https://www.xiaohongshu.com/search_result?keyword=store", styleFeature: true, domPath: "main/a" })),
  body: "这是一段正常的正文，不需要包含任何店铺名称或话题。", url: "https://www.xiaohongshu.com/explore/fixture", finalUrl: null,
});
function audit(config: StoreTopicConfig, brandName: string, storeName = identity.storeName, topics: string[] = [], channel = "XIAOHONGSHU") {
  const resolved = scopeStoreTopicsByPolicy(resolveStoreTopicConfig([config], { storeName, commercePlatform: "JD" }), brandName, channel);
  const requirement = buildStoreTopicAuditRequirement({ source: "EXCEL", channel, resolved });
  return { resolved, result: storeTopicAuditForNote(note(topics), requirement) };
}

describe("store mapping and explicit topic requirement", () => {
  it("Protected STORE_MAPPING_DOES_NOT_IMPLY_TOPIC_REQUIREMENT：默认空话题仍保留Canonical和Alias映射", () => {
    expect(validateAcceptedStoreTopics(undefined)).toEqual([]);
    expect(validateStoreTopicGroups({ acceptedTopics: undefined, requiredTopics: undefined }))
      .toEqual({ acceptedTopics: [], requiredTopics: [] });
    for (const storeName of [identity.storeName, "上游普通店铺"]) {
      for (const channel of ["XIAOHONGSHU", "DOUYIN"]) {
        const { resolved, result } = audit(identity, "佳贝艾特", storeName, [], channel);
        expect(resolved).toMatchObject({ status: "MATCHED", storeTopicRuleId: identity.id, failureReason: null });
        expect(result).toMatchObject({ status: "NOT_REQUIRED", needsReview: false, failureReason: null });
      }
    }
  });

  it("显式开启才校验话题，关闭不改变identity或alias，店名字样不决定要求", () => {
    const enabled = { ...identity, acceptedTopics: [topicEntry("#测试佳贝艾特店铺")], brandPolicies: [{
      brandName: "佳贝艾特", contentChannel: "XIAOHONGSHU", requireStoreTopic: true, useSharedTemplate: true, topicConfig: "{}",
    }] };
    expect(audit(enabled, "佳贝艾特").result.status).toBe("NON_COMPLIANT");
    expect(audit(enabled, "佳贝艾特", "上游普通店铺", ["#测试佳贝艾特店铺"]).result.status).toBe("COMPLIANT");
    const closed = { ...enabled, brandPolicies: enabled.brandPolicies.map(policy => ({ ...policy, requireStoreTopic: false })) };
    expect(audit(closed, "佳贝艾特", "上游普通店铺").result)
      .toMatchObject({ status: "NOT_REQUIRED", needsReview: false, failureReason: null });
    expect(closed.aliases).toEqual(identity.aliases);
    for (const storeName of ["任意旗舰店", "任意专卖店"]) {
      const config = { ...closed, storeName, normalizedStoreName: normalizeStoreNameForMatch(storeName) };
      expect(audit(config, "佳贝艾特", storeName).result.status).toBe("NOT_REQUIRED");
    }
  });

  it("雀巢显式关闭不继承共用话题，达能开启保留ACCEPTED OR加REQUIRED AND", () => {
    const configured = { ...identity, acceptedTopics: [topicEntry("#候选甲"), topicEntry("#候选乙", 1)],
      requiredTopics: [topicEntry("#必需甲"), topicEntry("#必需乙", 1)], brandPolicies: [
        { brandName: "达能", contentChannel: "XIAOHONGSHU", requireStoreTopic: true, useSharedTemplate: true, topicConfig: "{}" },
        { brandName: "雀巢", contentChannel: "XIAOHONGSHU", requireStoreTopic: false, useSharedTemplate: true, topicConfig: "{}" },
      ] };
    expect(audit(configured, "雀巢").result)
      .toMatchObject({ status: "NOT_REQUIRED", needsReview: false, failureReason: null });
    expect(audit(configured, "达能", identity.storeName, ["#候选乙", "#必需甲", "#必需乙"]).result.status)
      .toBe("COMPLIANT");
    expect(audit(configured, "达能", identity.storeName, ["#候选乙", "#必需甲"]).result.status)
      .toBe("NON_COMPLIANT");
    expect(audit(configured, "达能", identity.storeName, ["#必需甲", "#必需乙"]).result.status)
      .toBe("NON_COMPLIANT");
  });
});
