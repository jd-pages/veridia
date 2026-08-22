import { describe, expect, it } from "vitest";
import { evaluateAudit } from "@/lib/audit-engine";
import { createMockNote } from "@/lib/mock-data";
import {
  expectedStoreTopicForName,
  normalizeStoreNameForMatch,
  normalizeStoreTopicForMatch,
  resolveStoreTopicConfig,
  validateStoreTopic,
} from "@/lib/store-topic-config";
import {
  storeAcceptedTopicSeeds,
  storeNameAliasSeeds,
  storeRequiredTopicSeeds,
  storeTopicRuleSeeds,
} from "@/lib/store-topic-rule-seeds";
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

const storeTopicConfigs = storeTopicRuleSeeds.map((seed) => ({
  ...seed,
  normalizedStoreName: normalizeStoreNameForMatch(seed.storeName),
  aliases: [
    {
      id: `${seed.id}-canonical-alias`,
      alias: seed.storeName,
      normalizedAlias: normalizeStoreNameForMatch(seed.storeName),
      enabled: true,
    },
    ...storeAcceptedTopicSeeds
      .filter(
        (accepted) =>
          accepted.isStoreAlias &&
          accepted.commercePlatform === seed.commercePlatform &&
          normalizeStoreNameForMatch(accepted.storeName) ===
            normalizeStoreNameForMatch(seed.storeName),
      )
      .map((accepted, index) => ({
        id: `${seed.id}-alias-${index + 1}`,
        alias: accepted.topic.replace(/^#/u, ""),
        normalizedAlias: normalizeStoreTopicForMatch(accepted.topic),
        enabled: true,
      })),
    ...storeNameAliasSeeds
      .filter(
        (alias) =>
          alias.commercePlatform === seed.commercePlatform &&
          normalizeStoreNameForMatch(alias.canonicalStoreName) ===
            normalizeStoreNameForMatch(seed.storeName),
      )
      .map((alias, index) => ({
        id: `${seed.id}-store-alias-${index + 1}`,
        alias: alias.alias,
        normalizedAlias: normalizeStoreNameForMatch(alias.alias),
        enabled: true,
      })),
  ],
  expectedTopic: expectedStoreTopicForName(seed.storeName),
  acceptedTopics: [
    {
      id: `${seed.id}-topic-1`,
      topic: expectedStoreTopicForName(seed.storeName),
      normalizedTopic: normalizeStoreNameForMatch(seed.storeName),
      sortOrder: 0,
      enabled: true,
    },
    ...storeAcceptedTopicSeeds
      .filter(
        (accepted) =>
          accepted.commercePlatform === seed.commercePlatform &&
          normalizeStoreNameForMatch(accepted.storeName) ===
            normalizeStoreNameForMatch(seed.storeName),
      )
      .map((accepted, index) => ({
        id: `${seed.id}-topic-${index + 2}`,
        topic: accepted.topic,
        normalizedTopic: normalizeStoreTopicForMatch(accepted.topic),
        sortOrder: index + 1,
        enabled: true,
      })),
  ],
  requiredTopics: storeRequiredTopicSeeds
    .filter(
      (required) =>
        required.commercePlatform === seed.commercePlatform &&
        normalizeStoreNameForMatch(required.storeName) ===
          normalizeStoreNameForMatch(seed.storeName),
    )
    .map((required, index) => ({
      id: `${seed.id}-required-${index + 1}`,
      topic: required.topic,
      normalizedTopic: normalizeStoreNameForMatch(required.topic.replace(/^#/u, "")),
      sortOrder: index,
      enabled: true,
    })),
  enabled: true,
}));

const resolve = (input: { storeName?: unknown; commercePlatform?: unknown }) =>
  resolveStoreTopicConfig(storeTopicConfigs, input);

describe("店铺话题配置与精确审核", () => {
  it("配置清单由单一来源保存且不包含简称", () => {
    expect(storeTopicConfigs).toHaveLength(42);
    expect(
      resolve({
        storeName: "佳贝艾特(Kabrita)海外专卖店",
        commercePlatform: "京东",
      }),
    ).toMatchObject({
      status: "MATCHED",
      commercePlatform: "JD",
      expectedTopic: "#佳贝艾特(Kabrita)海外专卖店",
    });
    expect(resolve({ storeName: "佳贝艾特海外专卖店", commercePlatform: "京东" }).status)
      .toBe("STORE_NOT_MAPPED");
  });

  it.each([
    "佳贝艾特Kabrita海外专卖店",
    "佳贝艾特(Kabrita) 海外专卖店",
    "佳贝艾特(Kabrita)海外专卖",
    "佳贝艾特(Kabrita)海外专卖店旗舰",
  ])("括号、内部空格或字数不同均不能匹配：%s", (storeName) => {
    expect(resolve({ storeName, commercePlatform: "京东" }).status).toBe(
      "STORE_NOT_MAPPED",
    );
  });

  it.each([
    ["天猫", "FOLO海外专营店", "folo海外专营店"],
    ["京东", "aptamil爱他美海外进口超市", "Aptamil爱他美海外进口超市"],
    ["京东", "佳贝艾特(kabrita)海外专卖店", "佳贝艾特(Kabrita)海外专卖店"],
    ["抖音电商", "bellamy's贝拉米荣程海外专卖店", "Bellamy's贝拉米荣程海外专卖店"],
  ])("英文字母大小写不同仍精确匹配：%s / %s", (commercePlatform, storeName, matchedStoreName) => {
    expect(resolve({ commercePlatform, storeName })).toMatchObject({
      status: "MATCHED",
      matchedStoreName,
    });
  });

  it("爱他美优选店铺新旧名称精确归一到同一 identity", () => {
    const canonicalName = "Aptamil爱他美海外优选进口超市";
    const oldName = "爱他美优选海外专卖店";
    const oldResolution = resolve({ commercePlatform: "京东", storeName: oldName });
    const newResolution = resolve({ commercePlatform: "京东", storeName: canonicalName });

    expect(oldResolution).toMatchObject({
      status: "MATCHED",
      storeTopicRuleId: "store-topic-jd-01",
      matchedStoreName: canonicalName,
      expectedTopics: [`#${canonicalName}`, `#${oldName}`],
      requiredTopics: ["#京东"],
    });
    expect(newResolution).toMatchObject({
      status: "MATCHED",
      storeTopicRuleId: "store-topic-jd-01",
      matchedStoreName: canonicalName,
    });
    expect(newResolution.storeTopicRuleId).toBe(oldResolution.storeTopicRuleId);
    expect(oldResolution.config?.aliases.map((item) => item.alias)).toEqual([
      canonicalName,
      oldName,
    ]);
  });

  it.each([
    ["天猫", "天猫佳贝艾特海外旗舰店", "kabrita海外旗舰店"],
    ["天猫", "天猫佳贝艾特母婴海外旗舰店", "kabrita母婴海外旗舰店"],
    ["抖音", "抖音佳贝艾特海外旗舰店", "佳贝艾特kabrita海外旗舰店"],
    ["京东", "京东佳贝艾特(Kabrita)海外专卖店", "佳贝艾特(Kabrita)海外专卖店"],
    ["京东", "京东佳贝艾特官方海外旗舰店", "佳贝艾特官方海外旗舰店"],
    ["京东", "京东佳贝艾特海外京东自营旗舰店", "佳贝艾特海外京东自营旗舰店"],
    ["京东", "京东佳贝艾特(Kabrita)海外旗舰店", "佳贝艾特(Kabrita)海外旗舰店"],
  ])(
    "佳贝艾特平台显式 Alias 只归一到同平台 Canonical：%s / %s",
    (commercePlatform, storeName, matchedStoreName) => {
      const aliasResolution = resolve({ commercePlatform, storeName });
      const directResolution = resolve({
        commercePlatform,
        storeName: matchedStoreName,
      });
      expect(aliasResolution).toMatchObject({
        status: "MATCHED",
        storeName,
        matchedStoreName,
        storeTopicRuleId: directResolution.storeTopicRuleId,
        expectedTopics: directResolution.expectedTopics,
        requiredTopics: directResolution.requiredTopics,
      });
      expect(aliasResolution.expectedTopics).not.toContain(`#${storeName}`);
    },
  );

  it("Canonical 店铺名优先直接匹配且保留名称中的京东字样", () => {
    expect(resolve({
      commercePlatform: "京东",
      storeName: "佳贝艾特海外京东自营旗舰店",
    })).toMatchObject({
      status: "MATCHED",
      storeName: "佳贝艾特海外京东自营旗舰店",
      matchedStoreName: "佳贝艾特海外京东自营旗舰店",
      storeTopicRuleId: "store-topic-jd-12",
    });
  });

  it.each([
    ["天猫", "抖音佳贝艾特海外旗舰店"],
    ["抖音", "天猫佳贝艾特海外旗舰店"],
    ["京东", "天猫佳贝艾特海外旗舰店"],
  ])("佳贝艾特 Alias 不跨平台匹配：%s / %s", (commercePlatform, storeName) => {
    expect(resolve({ commercePlatform, storeName }).status).toBe(
      "STORE_NOT_MAPPED",
    );
  });

  it("没有显式 Alias 的其他品牌店铺不会自动剥离京东前缀", () => {
    expect(resolve({
      commercePlatform: "京东",
      storeName: "京东FOLO海外官方旗舰店",
    }).status).toBe("STORE_NOT_MAPPED");
  });

  it("同平台 Alias 指向多个 Canonical 时明确阻断", () => {
    const canonical = storeTopicConfigs.find(
      (config) =>
        config.commercePlatform === "JD" &&
        config.storeName === "佳贝艾特官方海外旗舰店",
    )!;
    const collision = storeTopicConfigs.find(
      (config) =>
        config.commercePlatform === "JD" &&
        config.storeName === "佳贝艾特(Kabrita)海外旗舰店",
    )!;
    const alias = "京东佳贝艾特官方海外旗舰店";
    const resolution = resolveStoreTopicConfig(
      storeTopicConfigs.map((config) =>
        config.id === collision.id
          ? {
              ...config,
              aliases: [
                ...config.aliases,
                {
                  id: "collision-alias",
                  alias,
                  normalizedAlias: normalizeStoreNameForMatch(alias),
                  enabled: true,
                },
              ],
            }
          : config,
      ),
      { commercePlatform: "京东", storeName: alias },
    );
    expect(canonical.id).not.toBe(collision.id);
    expect(resolution).toMatchObject({
      status: "STORE_NOT_MAPPED",
      matchedStoreName: null,
    });
    expect(resolution.failureReason).toContain("STORE_ALIAS_COLLISION");
  });

  it("爱他美优选店铺兼容英文大小写与首尾空格，但不扩大为简称或模糊匹配", () => {
    expect(resolve({
      commercePlatform: "京东",
      storeName: "  aptamil爱他美海外优选进口超市  ",
    })).toMatchObject({
      status: "MATCHED",
      storeTopicRuleId: "store-topic-jd-01",
    });
    for (const storeName of [
      "优选",
      "爱他美",
      "Aptamil爱他美海外进口超市优选",
      "爱他美精选海外专卖店",
    ]) {
      const resolution = resolve({ commercePlatform: "京东", storeName });
      if (storeName === "爱他美精选海外专卖店") {
        expect(resolution.storeTopicRuleId).not.toBe("store-topic-jd-01");
      } else {
        expect(resolution.status).toBe("STORE_NOT_MAPPED");
      }
    }
  });

  it.each([
    "#Aptamil爱他美海外优选进口超市",
    "#爱他美优选海外专卖店",
  ])("爱他美优选店铺的新旧可点击话题都保持合规：%s", (displayText) => {
    const resolved = resolve({
      commercePlatform: "京东",
      storeName: "爱他美优选海外专卖店",
    });
    expect(validateStoreTopic({
      channel: "XIAOHONGSHU",
      storeName: "爱他美优选海外专卖店",
      expectedTopics: resolved.expectedTopics,
      requiredTopics: resolved.requiredTopics,
      mappingStatus: resolved.status,
      extractedTopics: [topic(displayText), topic("#京东")],
      pageUrl: "https://www.xiaohongshu.com/explore/aptamil-store-rename",
    })).toMatchObject({ status: "COMPLIANT" });
  });

  it("只移除店铺名称首尾空格，并同时校验成交平台", () => {
    expect(
      resolve({
        storeName: "  京东健康官方进口超市  ",
        commercePlatform: "京东",
      }).status,
    ).toBe("MATCHED");
    expect(
      resolve({
        storeName: "京东健康官方进口超市",
        commercePlatform: "天猫",
      }).status,
    ).toBe("STORE_NOT_MAPPED");
  });

  it("只为指定平台和完整店铺名加载附加平台话题", () => {
    expect(
      resolve({ storeName: "健康官方进口超市", commercePlatform: "京东" })
        .requiredTopics,
    ).toEqual(["#京东"]);
    expect(
      resolve({ storeName: "FOLO海外专营店", commercePlatform: "天猫" })
        .requiredTopics,
    ).toEqual(["#天猫"]);
    expect(
      resolve({ storeName: "ALG阿莱购", commercePlatform: "淘宝" })
        .requiredTopics,
    ).toEqual(["#淘宝"]);
    expect(
      resolve({ storeName: "国际进口超市", commercePlatform: "淘宝" })
        .requiredTopics,
    ).toEqual(["#淘宝"]);
    expect(
      resolve({ storeName: "京东健康官方进口超市", commercePlatform: "京东" })
        .requiredTopics,
    ).toEqual([]);

    const taobaoAlg = storeTopicConfigs.find(
      (config) =>
        config.commercePlatform === "TAOBAO" && config.storeName === "ALG阿莱购",
    )!;
    expect(
      resolveStoreTopicConfig(
        [
          ...storeTopicConfigs,
          {
            ...taobaoAlg,
            id: "same-name-on-jd",
            commercePlatform: "JD",
            requiredTopics: [],
          },
        ],
        { storeName: "ALG阿莱购", commercePlatform: "京东" },
      ).requiredTopics,
    ).toEqual([]);
  });

  it.each([
    "FOLO海外店",
    "FOLO 海外专营店",
    "FOLO海外旗舰店",
  ])("不做简称、内部空格或近似匹配：%s", (storeName) => {
    expect(resolve({ storeName, commercePlatform: "天猫" }).status).toBe("STORE_NOT_MAPPED");
  });

  it("完整且可点击的店铺话题合规", () => {
    expect(
      validateStoreTopic({
        channel: "XIAOHONGSHU",
        storeName: "京东健康官方进口超市",
        expectedTopic: "#京东健康官方进口超市",
        mappingStatus: "MATCHED",
        extractedTopics: [topic("#京东健康官方进口超市")],
        pageUrl: "https://www.xiaohongshu.com/explore/123",
      }),
    ).toMatchObject({ status: "COMPLIANT", matchedTopic: "#京东健康官方进口超市" });
  });

  it("任意命中多个可接受店铺话题中的一条即合规", () => {
    const common = {
      channel: "XIAOHONGSHU",
      storeName: "ROCKCHECK海外专营店",
      expectedTopics: [
        "#ROCKCHECK海外专营店",
        "#ROCKCHECK海外旗舰店",
      ],
      mappingStatus: "MATCHED",
      pageUrl: "https://www.xiaohongshu.com/explore/123",
    };
    expect(
      validateStoreTopic({
        ...common,
        extractedTopics: [topic("#ROCKCHECK海外专营店")],
      }),
    ).toMatchObject({
      status: "COMPLIANT",
      matchedTopics: ["#ROCKCHECK海外专营店"],
    });
    expect(
      validateStoreTopic({
        ...common,
        extractedTopics: [topic("#rockcheck海外旗舰店")],
      }),
    ).toMatchObject({
      status: "COMPLIANT",
      matchedTopics: ["#rockcheck海外旗舰店"],
    });
    expect(
      validateStoreTopic({
        ...common,
        extractedTopics: [topic("#ROCKCHECK 海外旗舰店")],
      }).status,
    ).toBe("NON_COMPLIANT");
  });

  it("ROCKCHECK海外专营店的原话题与直播间话题严格二选一", () => {
    const resolved = resolve({
      storeName: "ROCKCHECK海外专营店",
      commercePlatform: "抖音电商",
    });
    expect(resolved).toMatchObject({
      status: "MATCHED",
      expectedTopics: [
        "#ROCKCHECK海外专营店",
        "#爱他美RC奶粉直播间",
      ],
      requiredTopics: [],
    });
    const common = {
      channel: "XIAOHONGSHU",
      storeName: "ROCKCHECK海外专营店",
      expectedTopics: resolved.expectedTopics,
      requiredTopics: resolved.requiredTopics,
      mappingStatus: "MATCHED" as const,
      pageUrl: "https://www.xiaohongshu.com/explore/123",
    };

    expect(
      validateStoreTopic({
        ...common,
        extractedTopics: [topic("#ROCKCHECK海外专营店")],
      }).status,
    ).toBe("COMPLIANT");
    expect(
      validateStoreTopic({
        ...common,
        extractedTopics: [topic("#爱他美RC奶粉直播间")],
      }).status,
    ).toBe("COMPLIANT");
    expect(
      validateStoreTopic({
        ...common,
        extractedTopics: [
          topic("#ROCKCHECK海外专营店"),
          topic("#爱他美RC奶粉直播间"),
        ],
      }).status,
    ).toBe("COMPLIANT");
    expect(
      validateStoreTopic({ ...common, extractedTopics: [] }).status,
    ).toBe("NON_COMPLIANT");
    expect(
      validateStoreTopic({
        ...common,
        extractedTopics: [topic("#爱他美RC奶粉直播间", false)],
        body: "正文提到爱他美RC奶粉直播间，但不是可点击话题。",
      }).status,
    ).toBe("NON_COMPLIANT");

    const otherStore = resolve({
      storeName: "FOLO海外旗舰店",
      commercePlatform: "抖音电商",
    });
    expect(
      validateStoreTopic({
        channel: "XIAOHONGSHU",
        storeName: "FOLO海外旗舰店",
        expectedTopics: otherStore.expectedTopics,
        requiredTopics: otherStore.requiredTopics,
        mappingStatus: "MATCHED",
        extractedTopics: [topic("#爱他美RC奶粉直播间")],
        pageUrl: "https://www.xiaohongshu.com/explore/123",
      }).status,
    ).toBe("NON_COMPLIANT");
  });

  it("普通正文命中第二条话题不算合规，且缺失原因保留全部候选", () => {
    const result = validateStoreTopic({
      channel: "XIAOHONGSHU",
      expectedTopics: [
        "#ROCKCHECK海外专营店",
        "#ROCKCHECK海外旗舰店",
      ],
      mappingStatus: "MATCHED",
      extractedTopics: [],
      body: "正文提到了ROCKCHECK海外旗舰店，但不是可点击话题。",
    });
    expect(result.status).toBe("NON_COMPLIANT");
    expect(result.failureReason).toContain("仅出现在正文中");
    expect(result.expectedTopics).toEqual([
      "#ROCKCHECK海外专营店",
      "#ROCKCHECK海外旗舰店",
    ]);
  });

  it("可接受话题组内 OR，附加必需话题组内 AND", () => {
    const common = {
      channel: "XIAOHONGSHU",
      expectedTopics: ["#健康官方进口超市", "#健康进口旗舰店"],
      requiredTopics: ["#京东"],
      mappingStatus: "MATCHED",
      pageUrl: "https://www.xiaohongshu.com/explore/123",
    };
    expect(
      validateStoreTopic({
        ...common,
        extractedTopics: [topic("#健康进口旗舰店"), topic("#京东")],
      }),
    ).toMatchObject({
      status: "COMPLIANT",
      matchedTopics: ["#健康进口旗舰店"],
      matchedRequiredTopics: ["#京东"],
    });
    expect(
      validateStoreTopic({
        ...common,
        extractedTopics: [topic("#健康官方进口超市")],
      }).failureReason,
    ).toBe("缺少附加必需话题：#京东");
    expect(
      validateStoreTopic({
        ...common,
        extractedTopics: [topic("#京东")],
      }).failureReason,
    ).toContain("未命中任何可接受店铺话题");
    expect(
      validateStoreTopic({
        ...common,
        extractedTopics: [
          topic("#健康官方进口超市"),
          topic("#京东", false),
        ],
      }).failureReason,
    ).toBe("附加必需话题不可点击：#京东");
    expect(
      validateStoreTopic({
        ...common,
        extractedTopics: [topic("#健康官方进口超市")],
        body: "正文里提到京东，但不是可点击话题。",
      }).failureReason,
    ).toBe("附加必需话题仅出现在正文中，未形成可点击话题：#京东");
  });

  it("淘宝店铺必须同时命中独立可点击的店铺话题和 #淘宝", () => {
    const common = {
      channel: "XIAOHONGSHU",
      expectedTopics: ["#ALG阿莱购"],
      requiredTopics: ["#淘宝"],
      mappingStatus: "MATCHED",
      pageUrl: "https://www.xiaohongshu.com/explore/taobao-store",
    };
    expect(
      validateStoreTopic({
        ...common,
        extractedTopics: [topic("#ALG阿莱购"), topic("#淘宝")],
      }).status,
    ).toBe("COMPLIANT");
    expect(
      validateStoreTopic({
        ...common,
        extractedTopics: [topic("#ALG阿莱购")],
      }).failureReason,
    ).toBe("缺少附加必需话题：#淘宝");
    expect(
      validateStoreTopic({
        ...common,
        extractedTopics: [topic("#淘宝")],
      }).failureReason,
    ).toContain("未命中任何可接受店铺话题");
    expect(
      validateStoreTopic({
        ...common,
        extractedTopics: [topic("#ALG阿莱购"), topic("#淘宝", false)],
      }).failureReason,
    ).toBe("附加必需话题不可点击：#淘宝");
  });

  it("可点击店铺话题仅忽略英文字母大小写", () => {
    expect(validateStoreTopic({
      channel: "XIAOHONGSHU",
      storeName: "FOLO海外专营店",
      expectedTopic: "#folo海外专营店",
      mappingStatus: "MATCHED",
      extractedTopics: [topic("#FOLO海外专营店")],
      pageUrl: "https://www.xiaohongshu.com/explore/123",
    })).toMatchObject({
      status: "COMPLIANT",
      matchedTopic: "#FOLO海外专营店",
    });
    expect(validateStoreTopic({
      channel: "XIAOHONGSHU",
      expectedTopic: "#folo海外专营店",
      mappingStatus: "MATCHED",
      extractedTopics: [topic("#FOLO 海外专营店")],
    }).status).toBe("NON_COMPLIANT");
  });

  it("停用规则不参与新匹配", () => {
    const disabled = storeTopicConfigs.map((rule) =>
      rule.storeName === "folo海外专营店" ? { ...rule, enabled: false } : rule,
    );
    expect(resolveStoreTopicConfig(disabled, {
      commercePlatform: "天猫",
      storeName: "FOLO海外专营店",
    }).status).toBe("STORE_NOT_MAPPED");
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
        storeTopicRuleId: "store-topic-jd-21",
        matchedStoreName: "京东健康官方进口超市",
        commercePlatform: "JD",
        expectedTopic: "#京东健康官方进口超市",
        expectedTopics: ["#京东健康官方进口超市"],
        requiredTopics: [],
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
      "未命中任何可接受店铺话题：#京东健康官方进口超市",
    );
  });

  it("正文普通文字、简称和不可点击完整话题均不合规并给出具体原因", () => {
    const common = {
      channel: "XIAOHONGSHU",
      storeName: "京东健康官方进口超市",
      expectedTopic: "#京东健康官方进口超市",
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
    }).failureReason).toBe("未命中任何可接受店铺话题：#京东健康官方进口超市");
    expect(validateStoreTopic({
      ...common,
      extractedTopics: [topic("#京东健康官方进口超市", false)],
    }).failureReason).toBe("可接受店铺话题不可点击：#京东健康官方进口超市");
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
        storeTopicRuleId: "store-topic-jd-21",
        matchedStoreName: "京东健康官方进口超市",
        commercePlatform: "JD",
        expectedTopic: "#京东健康官方进口超市",
        expectedTopics: ["#京东健康官方进口超市"],
        requiredTopics: [],
        mappingStatus: "MATCHED",
      },
    };
    const result = evaluateAudit(note, context);
    expect(result.autoStatus).toBe("NOTE_NOT_FOUND");
    expect(result.storeTopicStatus).toBe("NOT_CHECKED");
    expect(result.failureReasons.join("；")).not.toContain("店铺话题");
  });
});
