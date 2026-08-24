import { describe, expect, it } from "vitest";
import { evaluateAudit } from "@/lib/audit-engine";
import { effectiveHistoricalAuditResultWhere } from "@/lib/audit-task-deduplication";
import { campaignRequiresProductStage } from "@/lib/campaign-stage-requirement";
import {
  duplicateReauditMetadataFromNotes,
  withDuplicateReauditMetadata,
} from "@/lib/import-task-metadata";
import { inferDanoneAgencyProductStage } from "@/lib/import-template-type";
import { createMockNote } from "@/lib/mock-data";
import { processingFailurePageFacts } from "@/lib/processing-failure";
import {
  resolveStoreTopicConfig,
  validateStoreTopic,
  type StoreTopicConfig,
} from "@/lib/store-topic-config";
import type { AuditContext } from "@/lib/types";
import defaultRules from "@/rules/default-rules.json";

const auditContext: AuditContext = {
  productId: "protected-product",
  campaignId: "protected-campaign",
  campaignName: "受保护行为",
  ruleVersion: 1,
  minImageCount: 2,
  minBodyLength: 100,
  publicRequired: true,
  retentionDays: 0,
  bodyRequired: true,
  clickableTopicRequired: true,
  rules: [{
    id: "required-topic",
    scope: "CAMPAIGN",
    ruleType: "MUST_ALL",
    topic: "#正式活动话题",
    exactMatch: true,
    clickableRequired: true,
    caseSensitive: false,
    minCount: 1,
    sortOrder: 1,
    version: 1,
  }],
};

describe("Protected business invariants", () => {
  it("NOTE_NOT_FOUND 永不变成 PUBLIC，且只保留页面终态规则", () => {
    expect(processingFailurePageFacts(
      "NOTE_NOT_FOUND",
      JSON.stringify({ pageStatus: "NORMAL", isPublic: true }),
    )).toEqual({ pageStatus: "NOTE_NOT_FOUND", publicStatus: "UNKNOWN" });

    const result = evaluateAudit(createMockNote("not-found"), auditContext);
    expect(result.autoStatus).toBe("NOTE_NOT_FOUND");
    expect(result.publicStatus).not.toBe("PUBLIC");
    expect(result.bodyStatus).toBe("UNKNOWN");
    expect(result.imageStatus).toBe("NOT_REQUIRED");
    expect(result.missingTopics).toEqual([]);
    expect(result.ruleResults.map((item) => item.ruleKey)).toEqual([
      "GLOBAL_PAGE_STATUS",
    ]);
    expect(result.failureReasons).toEqual(["笔记不存在"]);
  });

  it("STORE_ALIAS 只完成身份映射，不能自动生成 accepted page topic", () => {
    const config: StoreTopicConfig = {
      id: "kabrita-douyin",
      commercePlatform: "DOUYIN_ECOMMERCE",
      storeName: "佳贝艾特kabrita海外旗舰店",
      normalizedStoreName: "佳贝艾特kabrita海外旗舰店",
      aliases: [{ id: "alias", alias: "抖音佳贝艾特海外旗舰店", normalizedAlias: "抖音佳贝艾特海外旗舰店", enabled: true }],
      expectedTopic: "",
      acceptedTopics: [],
      requiredTopics: [],
      enabled: true,
    };
    const resolved = resolveStoreTopicConfig([config], {
      commercePlatform: "DOUYIN_ECOMMERCE",
      storeName: "抖音佳贝艾特海外旗舰店",
    });
    expect(resolved).toMatchObject({
      status: "MATCHED",
      matchedStoreName: "佳贝艾特kabrita海外旗舰店",
      expectedTopics: [],
      requiredTopics: [],
    });
    expect(validateStoreTopic({
      channel: "XIAOHONGSHU",
      mappingStatus: resolved.status,
      expectedTopics: resolved.expectedTopics,
      requiredTopics: resolved.requiredTopics,
      extractedTopics: [],
    })).toMatchObject({
      status: "NOT_REQUIRED",
      needsReview: false,
      failureReason: null,
    });
  });

  it("Kabrita 兼容阶段字段不产生 PRODUCT_STAGE topic requirement", () => {
    const standardTopic = "#初见小温柔成长更友好";
    expect(campaignRequiresProductStage([
      { campaignId: "kabrita", topicCategory: "BRAND_COMMON", topic: standardTopic },
      ...["IFFO_P1", "IFFO_2", "GUM_3_4_1PLUS_2PLUS"].map((applicableStage) => ({
        campaignId: "kabrita",
        topicCategory: "PRODUCT_STAGE",
        applicableStage,
        topic: standardTopic,
      })),
    ])).toBe(false);
    const activeKabritaRules = defaultRules.topicRules.filter(
      (rule) => rule.brand === "佳贝艾特" && rule.status === "ACTIVE",
    );
    expect(activeKabritaRules.filter(
      (rule) => rule.topicCategory === "PRODUCT_STAGE",
    )).toEqual([]);
    expect(campaignRequiresProductStage(activeKabritaRules)).toBe(false);
  });

  it("删除结果不进入 effective history，history=0 也不能形成 duplicate metadata", () => {
    expect(effectiveHistoricalAuditResultWhere).toEqual({ supersededAt: null });
    const zeroHistory = {
      identity: "xhs-note:deleted",
      historicalCount: 0,
      confirmedAt: "2026-08-24T00:00:00.000Z",
      confirmedByUserId: "reviewer",
      confirmedByDisplayName: "审核员",
      sourceTaskIds: [],
    };
    expect(() => withDuplicateReauditMetadata("", zeroHistory)).toThrow();
    const serialized = withDuplicateReauditMetadata("", {
      ...zeroHistory,
      historicalCount: 1,
      sourceTaskIds: ["old-task"],
    }).replace('"historicalCount":1', '"historicalCount":0');
    expect(duplicateReauditMetadataFromNotes(serialized)).toBeNull();
  });

  it("Danone 阶段 IFFO/GUM 与段位语义不能反向交换", () => {
    expect(inferDanoneAgencyProductStage("澳白2段")).toMatchObject({
      normalizedProductName: "澳白",
      inferredStage: "2段",
      inferredGroup: "IFFO",
    });
    expect(inferDanoneAgencyProductStage("IFFO")).toMatchObject({
      normalizedProductName: "IFFO",
      inferredStage: null,
      inferredGroup: null,
    });
    expect(inferDanoneAgencyProductStage("GUM")).toMatchObject({
      normalizedProductName: "GUM",
      inferredStage: null,
      inferredGroup: null,
    });
  });
});
