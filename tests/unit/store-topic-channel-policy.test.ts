import { describe, expect, it } from "vitest";
import { evaluateAudit } from "@/lib/audit-engine";
import { createMockNote } from "@/lib/mock-data";
import { validateStoreTopic } from "@/lib/store-topic-config";
import type { AuditContext, ExtractedTopic, PageStatus } from "@/lib/types";

function topic(displayText: string, clickable = true): ExtractedTopic {
  return {
    displayText,
    isLinkElement: clickable,
    hasHref: clickable,
    href: clickable
      ? `https://www.douyin.com/search/${encodeURIComponent(displayText)}`
      : null,
    styleFeature: clickable,
    domPath: clickable ? "a[data-douyin-topic]" : "span.plain-text",
    source: "DOM",
  };
}

const accepted = "#FOLO海外官方旗舰店";
const required = "#京东";
const common = {
  storeName: "FOLO海外官方旗舰店",
  expectedTopics: [accepted],
  requiredTopics: [required],
  mappingStatus: "MATCHED" as const,
};

describe("按内容渠道执行店铺话题审核策略", () => {
  it("小红书继续要求任一 ACCEPTED 且全部 REQUIRED", () => {
    expect(validateStoreTopic({
      ...common,
      channel: "XIAOHONGSHU",
      extractedTopics: [topic(accepted), topic(required)],
    })).toMatchObject({
      status: "COMPLIANT",
      matchedTopics: [accepted],
      requiredTopics: [required],
      matchedRequiredTopics: [required],
    });

    const missingRequired = validateStoreTopic({
      ...common,
      channel: "XIAOHONGSHU",
      extractedTopics: [topic(accepted)],
    });
    expect(missingRequired.status).toBe("NON_COMPLIANT");
    expect(missingRequired.failureReason).toContain(required);
  });

  it("抖音只要求任一 ACCEPTED，并从审核快照中排除 REQUIRED", () => {
    expect(validateStoreTopic({
      ...common,
      channel: "DOUYIN",
      extractedTopics: [topic(accepted)],
    })).toMatchObject({
      status: "COMPLIANT",
      matchedTopics: [accepted],
      requiredTopics: [],
      matchedRequiredTopics: [],
      failureReason: null,
    });

    const platformTopicOnly = validateStoreTopic({
      ...common,
      channel: "DOUYIN",
      extractedTopics: [topic(required)],
    });
    expect(platformTopicOnly.status).toBe("NON_COMPLIANT");
    expect(platformTopicOnly.failureReason).toContain("可接受店铺话题");
    expect(platformTopicOnly.failureReason).not.toContain("附加必需话题");

    const both = validateStoreTopic({
      ...common,
      channel: "DOUYIN",
      extractedTopics: [topic(accepted), topic(required)],
    });
    expect(both.status).toBe("COMPLIANT");
    expect(both.requiredTopics).toEqual([]);
    expect(both.matchedRequiredTopics).toEqual([]);
  });

  it.each([
    ["JD", "#京东"],
    ["TMALL", "#天猫"],
    ["TAOBAO", "#淘宝"],
    ["DOUYIN_ECOMMERCE", "#抖音电商"],
  ])("抖音成交平台 %s 不会把 %s 变成附加必需条件", (_platform, platformTopic) => {
    const result = validateStoreTopic({
      channel: "DOUYIN",
      expectedTopics: [accepted],
      requiredTopics: [platformTopic],
      mappingStatus: "MATCHED",
      extractedTopics: [topic(accepted)],
    });
    expect(result.status).toBe("COMPLIANT");
    expect(result.requiredTopics).toEqual([]);
  });

  it("抖音仍只接受真实可点击的精确店铺话题", () => {
    const plainText = validateStoreTopic({
      ...common,
      channel: "DOUYIN",
      body: `正文中提到${accepted.slice(1)}但不是话题`,
      extractedTopics: [],
    });
    expect(plainText.status).toBe("NON_COMPLIANT");
    expect(plainText.failureReason).toContain("正文");

    const notClickable = validateStoreTopic({
      ...common,
      channel: "DOUYIN",
      extractedTopics: [topic(accepted, false)],
    });
    expect(notClickable.status).toBe("NON_COMPLIANT");
    expect(notClickable.failureReason).toContain("不可点击");
  });

  it("抖音保留英文大小写兼容，但不接受内部空格或简称", () => {
    expect(validateStoreTopic({
      ...common,
      channel: "DOUYIN",
      extractedTopics: [topic("#folo海外官方旗舰店")],
    }).status).toBe("COMPLIANT");
    expect(validateStoreTopic({
      ...common,
      channel: "DOUYIN",
      extractedTopics: [topic("#FOLO 海外官方旗舰店")],
    }).status).toBe("NON_COMPLIANT");
    expect(validateStoreTopic({
      ...common,
      channel: "DOUYIN",
      extractedTopics: [topic("#FOLO海外店")],
    }).status).toBe("NON_COMPLIANT");
  });

  it("STORE_NOT_MAPPED 仍是映射异常，不降级为店铺话题缺失", () => {
    const result = validateStoreTopic({
      channel: "DOUYIN",
      mappingStatus: "STORE_NOT_MAPPED",
      expectedTopics: [],
      requiredTopics: [required],
      extractedTopics: [topic(required)],
    });
    expect(result.status).toBe("UNREVIEWABLE");
    expect(result.expectedTopics).toEqual([]);
    expect(result.failureReason).toContain("未匹配店铺话题配置");
  });

  it("抖音 VIDEO 正常审核 ACCEPTED，图片规则保持 NOT_REQUIRED", () => {
    const note = createMockNote("passed");
    note.noteType = "VIDEO";
    note.imageExtractionStatus = "VIDEO_NOTE";
    note.imageCount = 0;
    note.topics = [topic(accepted)];
    const context: AuditContext = {
      productId: "product",
      campaignId: "campaign",
      campaignName: "抖音测试活动",
      contentChannel: "DOUYIN",
      ruleVersion: 1,
      bodyRequired: false,
      minBodyLength: 0,
      minImageCount: 3,
      publicRequired: false,
      retentionDays: 0,
      clickableTopicRequired: true,
      rules: [],
      storeTopicRequirement: {
        channel: "DOUYIN",
        storeName: "FOLO海外官方旗舰店",
        storeTopicRuleId: "store-rule",
        matchedStoreName: "FOLO海外官方旗舰店",
        commercePlatform: "JD",
        expectedTopic: accepted,
        expectedTopics: [accepted],
        requiredTopics: [required],
        mappingStatus: "MATCHED",
      },
    };
    const result = evaluateAudit(note, context);
    expect(result.storeTopicStatus).toBe("COMPLIANT");
    expect(result.requiredStoreTopics).toEqual([]);
    expect(result.imageStatus).toBe("NOT_REQUIRED");
  });

  it.each<PageStatus>([
    "NOTE_NOT_FOUND",
    "NO_PERMISSION",
    "LOGIN_EXPIRED",
    "SECURITY_VERIFICATION",
    "READ_FAILED",
    "NEEDS_CONFIRMATION",
  ])("异常页面 %s 不执行抖音店铺话题审核", (pageStatus) => {
    const note = createMockNote("passed");
    note.pageStatus = pageStatus;
    note.topics = [];
    const context: AuditContext = {
      productId: "product",
      campaignId: "campaign",
      campaignName: "抖音测试活动",
      contentChannel: "DOUYIN",
      ruleVersion: 1,
      bodyRequired: false,
      minBodyLength: 0,
      minImageCount: 0,
      publicRequired: false,
      retentionDays: 0,
      clickableTopicRequired: true,
      rules: [],
      storeTopicRequirement: {
        channel: "DOUYIN",
        storeName: "FOLO海外官方旗舰店",
        storeTopicRuleId: "store-rule",
        matchedStoreName: "FOLO海外官方旗舰店",
        commercePlatform: "JD",
        expectedTopic: accepted,
        expectedTopics: [accepted],
        requiredTopics: [required],
        mappingStatus: "MATCHED",
      },
    };
    const result = evaluateAudit(note, context);
    expect(result.storeTopicStatus).toBe("NOT_CHECKED");
    expect(result.requiredStoreTopics).toEqual([]);
    expect(result.storeTopicFailureReason).toBeNull();
  });
});
