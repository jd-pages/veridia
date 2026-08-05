import { describe, expect, it } from "vitest";
import { evaluateAudit } from "@/lib/audit-engine";
import { createMockNote } from "@/lib/mock-data";
import {
  resolveStoreTopicConfig,
  storeTopicConfigs,
  validateStoreTopic,
} from "@/lib/store-topic-config";
import type { AuditContext, ExtractedTopic } from "@/lib/types";

const topic = (
  displayText: string,
  clickable = true,
): ExtractedTopic => ({
  displayText,
  isLinkElement: clickable,
  hasHref: clickable,
  href: clickable ? "https://www.xiaohongshu.com/search_result?keyword=store" : null,
  styleFeature: clickable,
  domPath: "main/topic",
});

describe("店铺话题配置与精确审核", () => {
  it("配置清单由单一来源保存且不包含简称", () => {
    expect(storeTopicConfigs).toHaveLength(42);
    expect(
      resolveStoreTopicConfig({
        storeName: "佳贝艾特(Kabrita)海外专卖店",
      }),
    ).toMatchObject({
      status: "MATCHED",
      commercePlatform: "JD",
      expectedTopic: "佳贝艾特(Kabrita)海外专卖店",
    });
    expect(resolveStoreTopicConfig({ storeName: "佳贝艾特海外专卖店" }).status)
      .toBe("STORE_NOT_MAPPED");
  });

  it.each([
    "佳贝艾特(kabrita)海外专卖店",
    "佳贝艾特Kabrita海外专卖店",
    "佳贝艾特(Kabrita) 海外专卖店",
    "佳贝艾特(Kabrita)海外专卖",
    "佳贝艾特(Kabrita)海外专卖店旗舰",
  ])("大小写、括号、内部空格或字数不同均不能匹配：%s", (storeName) => {
    expect(resolveStoreTopicConfig({ storeName }).status).toBe(
      "STORE_NOT_MAPPED",
    );
  });

  it("只移除店铺名称首尾空格，并同时校验成交平台", () => {
    expect(
      resolveStoreTopicConfig({
        storeName: "  京东健康官方进口超市  ",
        commercePlatform: "京东",
      }).status,
    ).toBe("MATCHED");
    expect(
      resolveStoreTopicConfig({
        storeName: "京东健康官方进口超市",
        commercePlatform: "天猫",
      }).status,
    ).toBe("STORE_NOT_MAPPED");
  });

  it("完整且可点击的店铺话题合规", () => {
    expect(
      validateStoreTopic({
        channel: "XIAOHONGSHU",
        storeName: "京东健康官方进口超市",
        expectedTopic: "京东健康官方进口超市",
        mappingStatus: "MATCHED",
        extractedTopics: [topic("#京东健康官方进口超市")],
        pageUrl: "https://www.xiaohongshu.com/explore/123",
      }),
    ).toMatchObject({ status: "COMPLIANT", matchedTopic: "#京东健康官方进口超市" });
  });

  it("店铺话题作为独立规则参与综合话题结论", () => {
    const context: AuditContext = {
      productId: "p",
      campaignId: "c",
      campaignName: "测试活动",
      ruleVersion: 1,
      minImageCount: 0,
      minBodyLength: 0,
      publicRequired: false,
      retentionDays: 0,
      bodyRequired: false,
      clickableTopicRequired: true,
      rules: [],
      storeTopicRequirement: {
        channel: "XIAOHONGSHU",
        storeName: "京东健康官方进口超市",
        commercePlatform: "JD",
        expectedTopic: "京东健康官方进口超市",
        mappingStatus: "MATCHED",
      },
    };
    const matchingNote = createMockNote("passed");
    matchingNote.topics.push(topic("#京东健康官方进口超市"));
    const compliant = evaluateAudit(matchingNote, context);
    expect(compliant.storeTopicStatus).toBe("COMPLIANT");
    expect(compliant.topicsCompliant).toBe(true);

    const missing = evaluateAudit(createMockNote("passed"), context);
    expect(missing.storeTopicStatus).toBe("NON_COMPLIANT");
    expect(missing.topicsCompliant).toBe(false);
    expect(missing.failureReasons.join("；")).toContain(
      "缺少店铺话题：#京东健康官方进口超市",
    );
  });

  it("正文普通文字、简称和不可点击完整话题均不合规并给出具体原因", () => {
    const common = {
      channel: "XIAOHONGSHU",
      storeName: "京东健康官方进口超市",
      expectedTopic: "京东健康官方进口超市",
      mappingStatus: "MATCHED",
      pageUrl: "https://www.xiaohongshu.com/explore/123",
    };
    expect(validateStoreTopic({
      ...common,
      extractedTopics: [],
      body: "正文提到京东健康官方进口超市，但没有正式话题",
    }).failureReason).toContain("仅出现在正文中");
    expect(validateStoreTopic({
      ...common,
      extractedTopics: [topic("#京东健康")],
    }).failureReason).toBe("缺少店铺话题：#京东健康官方进口超市");
    expect(validateStoreTopic({
      ...common,
      extractedTopics: [topic("#京东健康官方进口超市", false)],
    }).failureReason).toBe("店铺话题不可点击：#京东健康官方进口超市");
  });

  it("店铺未映射无法审核，NOTE_NOT_FOUND 仍优先短路为未审核", () => {
    expect(validateStoreTopic({
      channel: "XIAOHONGSHU",
      mappingStatus: "STORE_NOT_MAPPED",
      extractedTopics: [],
    }).status).toBe("UNREVIEWABLE");

    const note = createMockNote("not-found");
    const context: AuditContext = {
      productId: "p",
      campaignId: "c",
      campaignName: "测试活动",
      ruleVersion: 1,
      minImageCount: 0,
      minBodyLength: 0,
      publicRequired: false,
      retentionDays: 0,
      bodyRequired: false,
      clickableTopicRequired: true,
      rules: [],
      storeTopicRequirement: {
        channel: "XIAOHONGSHU",
        storeName: "京东健康官方进口超市",
        commercePlatform: "JD",
        expectedTopic: "京东健康官方进口超市",
        mappingStatus: "MATCHED",
      },
    };
    const result = evaluateAudit(note, context);
    expect(result.autoStatus).toBe("NOTE_NOT_FOUND");
    expect(result.storeTopicStatus).toBe("NOT_CHECKED");
    expect(result.failureReasons.join("；")).not.toContain("店铺话题");
  });
});
