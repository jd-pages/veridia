import { expect, it } from "vitest";
import { scopeStoreTopicsByPolicy } from "@/lib/store-brand-topic-policy";
import { buildStoreTopicAuditRequirement, resolveStoreTopicConfig, storeTopicAuditForNote, type StoreTopicConfig } from "@/lib/store-topic-config";
const topic = (name: string) => ({ id: name, topic: name, normalizedTopic: name.slice(1), enabled: true, sortOrder: 0 });
const config: StoreTopicConfig = { id: "store-a", commercePlatform: "JD", storeName: "共享店铺", normalizedStoreName: "共享店铺", enabled: true,
  aliases: [{ id: "alias", alias: "上游店铺", normalizedAlias: "上游店铺", enabled: true }],
  expectedTopic: "#共享甲", acceptedTopics: [topic("#共享甲"), topic("#共享乙")], requiredTopics: [topic("#必需")],
  brandPolicies: [
    { brandName: "达能", contentChannel: "XIAOHONGSHU", requireStoreTopic: true, useSharedTemplate: true, topicConfig: "{}" },
    { brandName: "达能", contentChannel: "DOUYIN", requireStoreTopic: true, useSharedTemplate: true, topicConfig: "{}" },
    { brandName: "佳贝艾特", contentChannel: "XIAOHONGSHU", requireStoreTopic: false, useSharedTemplate: true, topicConfig: "{}" },
    { brandName: "雀巢", contentChannel: "XIAOHONGSHU", requireStoreTopic: false, useSharedTemplate: true, topicConfig: "{}" },
  ] };
function run(store: StoreTopicConfig, brandName: string, channel = "XIAOHONGSHU", names: string[] = []) {
  const scoped = scopeStoreTopicsByPolicy(resolveStoreTopicConfig([store], { commercePlatform: "JD", storeName: "上游店铺" }), brandName, channel);
  const result = storeTopicAuditForNote({ body: "正常正文", url: "https://www.xiaohongshu.com/explore/fixture", finalUrl: null,
    topics: names.map(displayText => ({ displayText, isLinkElement: true, hasHref: true, href: channel === "DOUYIN" ? "https://www.douyin.com/search/fixture?type=topic" : "https://www.xiaohongshu.com/search_result?keyword=fixture", styleFeature: true, domPath: "a" })) },
  buildStoreTopicAuditRequirement({ resolved: scoped, source: "EXCEL", channel }));
  return { scoped, result };
}
it("Protected STORE_BRAND_TOPIC_POLICY_ISOLATION：同店不同品牌不继承，雀巢可开启、达能可关闭", () => {
  expect(run(config, "达能").result.status).toBe("NON_COMPLIANT");
  for (const brand of ["佳贝艾特", "雀巢", "动态新增品牌"]) {
    expect(run(config, brand).result).toMatchObject({ status: "NOT_REQUIRED", failureReason: null, needsReview: false });
  }
  const changed = { ...config, brandPolicies: config.brandPolicies!.map(policy => policy.contentChannel === "XIAOHONGSHU"
    ? { ...policy, requireStoreTopic: policy.brandName === "雀巢" } : policy) };
  expect(run(changed, "达能").result.status).toBe("NOT_REQUIRED");
  expect(run(changed, "雀巢").result.status).toBe("NON_COMPLIANT");
  expect(run(changed, "雀巢", "XIAOHONGSHU", ["#共享乙", "#必需"]).result.status).toBe("COMPLIANT");
});
it("Protected STORE_MAPPING_INDEPENDENT_FROM_TOPIC_REQUIREMENT：Alias和店铺identity不受政策或其它店铺影响", () => {
  for (const brand of ["佳贝艾特", "雀巢"]) expect(run(config, brand).scoped).toMatchObject({ status: "MATCHED", storeTopicRuleId: "store-a", failureReason: null, expectedTopics: [] });
  const other = { ...config, id: "store-b", brandPolicies: [] };
  expect(run(other, "达能").result.status).toBe("NOT_REQUIRED");
  expect(run(config, "达能").result.status).toBe("NON_COMPLIANT");
});
it("共用和自定义独立，内容渠道保留XHS ACCEPTED OR/REQUIRED AND与DOUYIN ACCEPTED OR", () => {
  expect(run(config, "达能", "XIAOHONGSHU", ["#共享乙"]).result.status).toBe("NON_COMPLIANT");
  expect(run(config, "达能", "DOUYIN", ["#共享乙"]).result.status).toBe("COMPLIANT");
  const custom = { ...config, brandPolicies: [{ brandName: "任意新品牌", contentChannel: "XIAOHONGSHU", requireStoreTopic: true, useSharedTemplate: false,
    topicConfig: JSON.stringify({ acceptedTopics: ["#品牌自定义"], requiredTopics: [] }) }] };
  expect(run(custom, "任意新品牌", "XIAOHONGSHU", ["#共享甲", "#必需"]).result.status).toBe("NON_COMPLIANT");
  expect(run(custom, "任意新品牌", "XIAOHONGSHU", ["#品牌自定义"]).result.status).toBe("COMPLIANT");
});
it("已开启但空话题、坏JSON、或抖音仅REQUIRED配置必须安全阻断，不能降为NOT_REQUIRED", () => {
  for (const topicConfig of ["invalid", '{"acceptedTopics":[],"requiredTopics":[]}']) {
    const invalid = { ...config, brandPolicies: [{ brandName: "雀巢", contentChannel: "XIAOHONGSHU", requireStoreTopic: true, useSharedTemplate: false, topicConfig }] };
    expect(run(invalid, "雀巢").result).toMatchObject({ status: "UNREVIEWABLE", needsReview: true });
  }
  const requiredOnly = { ...config, acceptedTopics: [], expectedTopic: "" };
  expect(run(requiredOnly, "达能", "DOUYIN").result).toMatchObject({ status: "UNREVIEWABLE", needsReview: true });
});
