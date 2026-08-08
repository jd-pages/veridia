import { describe, expect, it } from "vitest";
import {
  countEffectiveBodyCharacters,
  evaluateAudit,
  extractEffectiveBodyText,
} from "@/lib/audit-engine";
import { createMockNote } from "@/lib/mock-data";
import type { AuditContext } from "@/lib/types";
import { MIN_BODY_LENGTH } from "@/lib/audit-constants";
import defaultRules from "@/rules/default-rules.json";

const context: AuditContext = {
  productId: "p1",
  campaignId: "c1",
  campaignName: "测试活动",
  ruleVersion: 3,
  minImageCount: 2,
  minBodyLength: MIN_BODY_LENGTH,
  publicRequired: false,
  retentionDays: 0,
  bodyRequired: true,
  clickableTopicRequired: true,
  rules: [
    {
      id: "r1",
      scope: "CAMPAIGN",
      ruleType: "MUST_ALL",
      topic: "#inne多维锌",
      exactMatch: true,
      clickableRequired: true,
      caseSensitive: false,
      minCount: 1,
      sortOrder: 1,
      version: 1,
    },
    ...["#宝宝营养", "#宝宝挑食", "#儿童营养"].map((topic, index) => ({
      id: `any-${index}`,
      scope: "CAMPAIGN",
      ruleType: "ANY",
      topic,
      exactMatch: true,
      clickableRequired: false,
      caseSensitive: false,
      minCount: 1,
      sortOrder: 10 + index,
      version: 1,
    })),
    {
      id: "forbidden",
      scope: "CAMPAIGN",
      ruleType: "FORBIDDEN",
      topic: "#治疗挑食",
      exactMatch: true,
      clickableRequired: false,
      caseSensitive: false,
      minCount: 1,
      sortOrder: 20,
      version: 1,
    },
  ],
};

describe("audit engine", () => {
  it.each(["passed", "failed"] as const)(
    "平台发帖时间不会改变 %s 案例的审核结论和失败原因",
    (caseName) => {
      const note = createMockNote(caseName);
      const withoutPublishedAt = evaluateAudit(
        {
          ...note,
          publishedAt: null,
          publishedAtRaw: null,
          publishedAtSource: null,
        },
        context,
      );
      const withPublishedAt = evaluateAudit(note, context);
      expect(withPublishedAt.autoStatus).toBe(withoutPublishedAt.autoStatus);
      expect(withPublishedAt.failureReasons).toEqual(
        withoutPublishedAt.failureReasons,
      );
    },
  );

  it("笔记不存在且没有发帖时间时不增加第二个失败原因", () => {
    const note = createMockNote("not-found");
    note.publishedAt = null;
    const result = evaluateAudit(note, context);
    expect(result.autoStatus).toBe("NOTE_NOT_FOUND");
    expect(result.failureReasons).toEqual(["笔记不存在"]);
  });
  it("抖音尚未配置业务规则时只保存采集结果并进入人工复核", () => {
    const result = evaluateAudit(
      { ...createMockNote("passed"), noteType: "VIDEO", adapterName: "playwright-douyin" },
      { ...context, contentChannel: "DOUYIN", rulesConfigured: false },
    );
    expect(result.autoStatus).toBe("NEEDS_REVIEW");
    expect(result.failureReasons).toEqual(["抖音采集成功，业务规则未配置"]);
    expect(result.missingTopics).toEqual([]);
  });
  it("抖音视频使用业务规则审核但图片数量明确不适用", () => {
    const result = evaluateAudit(
      { ...createMockNote("video-note"), noteType: "VIDEO" },
      { ...context, contentChannel: "DOUYIN", rulesConfigured: true },
    );
    expect(result.imageStatus).toBe("NOT_REQUIRED");
    expect(result.imageCount).toBeNull();
    expect(result.failureReasons.join("；")).not.toContain("图片数量不足");
  });
  it("抖音正常作品不参与公开状态审核，历史活动值为 true 也不会误入复核", () => {
    const note = createMockNote("passed");
    note.isPublic = null;
    const result = evaluateAudit(note, {
      ...context,
      contentChannel: "DOUYIN",
      rulesConfigured: true,
      publicRequired: true,
    });
    expect(result.publicStatus).toBe("NOT_REQUIRED");
    expect(result.autoStatus).toBe("PASSED");
    expect(result.failureReasons.join("；")).not.toContain("公开");
  });
  it("小红书公开状态规则保持原有行为", () => {
    const note = createMockNote("passed");
    note.isPublic = null;
    const result = evaluateAudit(note, {
      ...context,
      contentChannel: "XIAOHONGSHU",
      rulesConfigured: true,
      publicRequired: true,
    });
    expect(result.publicStatus).toBe("UNKNOWN");
    expect(result.autoStatus).toBe("NEEDS_REVIEW");
  });
  it("抖音无权限页面仍按 NO_PERMISSION 短路，不会因公开免审变成 NORMAL", () => {
    const note = createMockNote("passed");
    note.pageStatus = "NO_PERMISSION";
    const result = evaluateAudit(note, {
      ...context,
      contentChannel: "DOUYIN",
      rulesConfigured: true,
      publicRequired: false,
    });
    expect(result.pageStatus).toBe("NO_PERMISSION");
    expect(result.autoStatus).toBe("NEEDS_REVIEW");
    expect(result.publicStatus).toBe("NOT_REQUIRED");
    expect(result.bodyStatus).toBe("UNKNOWN");
    expect(result.storeTopicStatus).toBe("NOT_CHECKED");
  });
  it("正文字符数只计算完整 body，不会叠加来自同一 caption 的标题摘要", () => {
    const note = createMockNote("passed");
    note.title = "这是正文的标题摘要";
    note.body = "这是完整抖音作品正文，标题摘要不应被再次拼接计入正文字符数。";
    const result = evaluateAudit(note, {
      ...context,
      contentChannel: "DOUYIN",
      rulesConfigured: true,
      minBodyLength: 1,
    });
    expect(result.effectiveBodyLength).toBe(
      countEffectiveBodyCharacters(note.body, note.topics.map((topic) => topic.displayText)),
    );
  });
  it("结构化数据确认 caption 真实为空时按正文规则失败而不是无理由复核", () => {
    const note = createMockNote("passed");
    note.body = "";
    note.technicalWarnings = [];
    const result = evaluateAudit(note, {
      ...context,
      contentChannel: "DOUYIN",
      rulesConfigured: true,
      bodyRequired: true,
    });
    expect(result.bodyStatus).toBe("EMPTY");
    expect(result.autoStatus).toBe("FAILED");
    expect(result.failureReasons.join("；")).toContain("笔记正文为空");
  });
  it("抖音使用独立规则且缺少小红书新手爸妈话题不会失败", () => {
    const xhsCampaign = defaultRules.campaigns.find(
      (campaign) => campaign.key === "activity_bd673ea91f342c12a819",
    )!;
    const douyinCampaign = defaultRules.campaigns.find(
      (campaign) => campaign.key === "douyin_activity_bd673ea91f342c12a819",
    )!;
    const productKey = xhsCampaign.productKeys[0];
    const applicable = (channel: "XIAOHONGSHU" | "DOUYIN") =>
      defaultRules.topicRules.filter(
        (rule) =>
          (rule.contentChannel || "XIAOHONGSHU") === channel &&
          rule.campaignKey ===
            (channel === "DOUYIN" ? douyinCampaign.key : xhsCampaign.key) &&
          (!rule.productKey || rule.productKey === productKey) &&
          (!rule.applicableStage || rule.applicableStage === "IFFO_2"),
      );
    const toContext = (
      campaign: typeof xhsCampaign,
      channel: "XIAOHONGSHU" | "DOUYIN",
    ): AuditContext => ({
      productId: productKey,
      campaignId: campaign.key,
      campaignName: campaign.name,
      contentChannel: channel,
      rulesConfigured: true,
      ruleVersion: campaign.ruleRevision,
      minImageCount: campaign.minImageCount,
      minBodyLength: campaign.minBodyLength,
      publicRequired: campaign.publicRequired,
      retentionDays: campaign.retentionDays,
      bodyRequired: campaign.bodyRequired,
      clickableTopicRequired: campaign.clickableTopicRequired,
      rules: applicable(channel).map((rule) => ({
        id: rule.key,
        scope: rule.scope,
        ruleType: rule.ruleType,
        topic: rule.topic,
        exactMatch: rule.exactMatch,
        clickableRequired: rule.clickableRequired,
        caseSensitive: rule.caseSensitive,
        minCount: rule.minCount,
        sortOrder: rule.sortOrder,
        version: rule.revision,
        topicCategory: rule.topicCategory,
        applicableStage: rule.applicableStage,
        milkType: rule.milkType,
      })),
    });
    const note = createMockNote("passed");
    note.body = "这是一段满足正文长度要求且不依赖小红书专属话题的抖音审核正文。".repeat(3);
    note.imageCount = 3;
    note.topics = applicable("DOUYIN").map((rule) => ({
      displayText: rule.topic,
      isLinkElement: true,
      hasHref: true,
      href: `https://www.douyin.com/search/${encodeURIComponent(rule.topic)}`,
      styleFeature: true,
    }));

    const douyin = evaluateAudit(note, toContext(douyinCampaign, "DOUYIN"));
    const xhs = evaluateAudit(note, toContext(xhsCampaign, "XIAOHONGSHU"));
    expect(douyin.autoStatus).toBe("PASSED");
    expect(douyin.missingTopics).not.toContain("#爱他美新手爸妈日记");
    expect(xhs.autoStatus).toBe("FAILED");
    expect(xhs.missingTopics).toContain("#爱他美新手爸妈日记");
  });
  it.each(["not-found", "deleted"] as const)(
    "页面失效 %s 时短路正文、图片和话题审核",
    (caseName) => {
      const note = createMockNote(caseName);
      note.technicalWarnings = [
        "BODY_NOT_RECOGNIZED",
        "TOPICS_NOT_RECOGNIZED",
      ];
      const result = evaluateAudit(note, context);
      expect(result.autoStatus).toBe("NOTE_NOT_FOUND");
      expect(result.bodyStatus).toBe("UNKNOWN");
      expect(result.imageStatus).toBe("NOT_REQUIRED");
      expect(result.topicsCompliant).toBe(true);
      expect(result.missingTopics).toEqual([]);
      expect(result.ruleResults).toHaveLength(1);
      expect(result.ruleResults[0].ruleKey).toBe("GLOBAL_PAGE_STATUS");
      expect(result.failureReasons.join("；")).not.toMatch(
        /未识别到话题|缺少精确话题|有效正文字数不足|图片数量不足/u,
      );
    },
  );

  it("话题技术读取失败时保留正文结论并进入待人工复核", () => {
    const note = createMockNote("no-topics");
    note.body = "这是一段长度足够且可以正常参与固定规则审核的正文内容。".repeat(2);
    note.technicalWarnings = ["TOPICS_NOT_RECOGNIZED"];
    const result = evaluateAudit(note, context);
    expect(result.bodyStatus).toBe("PRESENT");
    expect(result.bodyCompliant).toBe(true);
    expect(result.autoStatus).toBe("NEEDS_REVIEW");
    expect(result.missingTopics).toEqual([]);
    expect(result.failureReasons).toContain("未识别到话题内容，需人工复核");
  });

  it("通过完整合规案例", () => {
    const result = evaluateAudit(createMockNote("passed"), context);
    expect(result.autoStatus).toBe("PASSED");
    expect(result.failureReasons).toEqual([]);
  });

  it("图文笔记读取数量并执行最低图片规则", () => {
    const passed = evaluateAudit(createMockNote("passed"), context);
    expect(passed.imageStatus).toBe("COMPLIANT");
    expect(passed.imageCount).toBe(3);

    const fewImages = evaluateAudit(createMockNote("few-images"), context);
    expect(fewImages.imageStatus).toBe("NON_COMPLIANT");
    expect(fewImages.autoStatus).toBe("FAILED");
    expect(fewImages.failureReasons.join()).toContain("图片数量不足");
  });

  it("LIVE 图文轮播的三张图片正常参与最低图片数量审核", () => {
    const result = evaluateAudit(createMockNote("live-photo"), context);
    expect(result.noteType).toBe("IMAGE_TEXT");
    expect(result.imageCount).toBe(3);
    expect(result.imageStatus).toBe("COMPLIANT");
    expect(result.imageCompliant).toBe(true);
    expect(result.autoStatus).toBe("PASSED");
  });

  it("图片数量读取失败进入人工复核，不生成图片不合规结论", () => {
    const noImages = createMockNote("no-images");
    const result = evaluateAudit(noImages, context);
    expect(result.imageStatus).toBe("IMAGES_READ_FAILED");
    expect(result.autoStatus).toBe("NEEDS_REVIEW");
    expect(result.imageCompliant).toBeNull();
    expect(result.failureReasons.join()).not.toContain("图片");
    expect(evaluateAudit(createMockNote("empty-body"), context).bodyStatus).toBe(
      "EMPTY",
    );
  });

  it("视频笔记标记 VIDEO_NOTE，不误判为 0 张", () => {
    const result = evaluateAudit(createMockNote("video-note"), context);
    expect(result.noteType).toBe("VIDEO_NOTE");
    expect(result.imageStatus).toBe("VIDEO_NOTE");
    expect(result.imageCount).toBeNull();
    expect(result.autoStatus).toBe("PASSED");
  });

  it("严格拒绝错字话题", () => {
    const result = evaluateAudit(createMockNote("inaccurate-topic"), context);
    expect(result.autoStatus).toBe("FAILED");
    expect(result.missingTopics).toContain("#inne多维锌");
  });

  it("不能只根据蓝色判断可点击", () => {
    const result = evaluateAudit(createMockNote("unclickable-topic"), context);
    expect(result.clickableCompliant).toBe(false);
    expect(result.failureReasons.join()).toContain("要求话题不可点击 #inne多维锌");
    expect(result.missingTopics).not.toContain("#inne多维锌");
  });

  it.each([
    {
      name: "链接元素",
      topic: { isLinkElement: true, hasHref: false, href: null },
    },
    {
      name: "存在 href",
      topic: {
        isLinkElement: false,
        hasHref: true,
        href: "https://www.xiaohongshu.com/unknown-path",
      },
    },
    ...[
      "search",
      "search_result",
      "tag",
      "topic",
      "explore",
      "hashtag",
      "keyword",
      "note",
    ].map(
      (path) => ({
        name: `${path} 路径`,
        topic: {
          isLinkElement: false,
          hasHref: false,
          href: `https://www.xiaohongshu.com/${path}/value`,
        },
      }),
    ),
  ])("$name 证据可独立判定话题可点击", ({ topic }) => {
    const note = createMockNote("passed");
    note.topics[0] = {
      ...note.topics[0],
      ...topic,
      styleFeature: false,
    };
    const result = evaluateAudit(note, context);
    expect(result.clickableCompliant).toBe(true);
    expect(result.failureReasons.join("；")).not.toContain("要求话题不可点击");
  });

  it("同一话题多个候选时任意一个可点击即整体通过", () => {
    const note = createMockNote("passed");
    note.topics = [
      {
        displayText: "#inne多维锌",
        isLinkElement: false,
        hasHref: false,
        href: null,
        styleFeature: false,
        domPath: "span.plain-topic",
        source: "DOM_TEXT",
      },
      {
        displayText: "＃ inne多维锌\n",
        isLinkElement: true,
        hasHref: false,
        href: null,
        styleFeature: false,
        domPath: "a.topic",
        source: "DOM_LINK",
      },
      note.topics[1],
    ];
    const result = evaluateAudit(note, context);
    expect(result.autoStatus).toBe("PASSED");
    expect(result.clickableCompliant).toBe(true);
  });

  it("小红书正文标准话题缺少 href 和 DOM 证据时仍判定可点击", () => {
    const note = createMockNote("passed");
    note.topics[0] = {
      ...note.topics[0],
      isLinkElement: false,
      hasHref: false,
      href: null,
      styleFeature: true,
      domPath: null,
      source: "BODY_VISIBLE_TEXT",
    };
    const result = evaluateAudit(note, context);
    expect(result.autoStatus).toBe("PASSED");
    expect(result.clickableCompliant).toBe(true);
    expect(result.failureReasons.join("；")).not.toContain("要求话题不可点击");
    expect(
      result.ruleResults.find((rule) => rule.ruleKey === "TOPIC_r1"),
    ).toMatchObject({
      passed: true,
      actualValue: "精确出现，可点击",
    });
  });

  it("正文和标准话题已提取时忽略已解决的话题读取告警", () => {
    const note = createMockNote("passed");
    note.topics[0] = {
      ...note.topics[0],
      isLinkElement: false,
      hasHref: false,
      href: null,
      styleFeature: false,
      domPath: null,
      source: "BODY_VISIBLE_TEXT",
    };
    note.technicalWarnings = ["TOPICS_NOT_RECOGNIZED"];

    const result = evaluateAudit(note, context);
    expect(result.autoStatus).toBe("PASSED");
    expect(result.failureReasons).not.toContain(
      "未识别到话题内容，需人工复核",
    );
  });

  it("非小红书页面的无交互标准文本不会自动判定可点击", () => {
    const note = createMockNote("passed");
    note.url = "https://example.com/note/1";
    note.finalUrl = note.url;
    note.topics[0] = {
      ...note.topics[0],
      isLinkElement: false,
      hasHref: false,
      href: null,
      styleFeature: false,
      domPath: null,
      source: "BODY_VISIBLE_TEXT",
    };

    const result = evaluateAudit(note, context);
    expect(result.autoStatus).toBe("NEEDS_REVIEW");
    expect(
      result.ruleResults.find((rule) => rule.ruleKey === "TOPIC_r1"),
    ).toMatchObject({
      actualValue: "精确出现，可点击状态需人工确认",
    });
  });

  it("识别禁止话题", () => {
    const result = evaluateAudit(createMockNote("failed"), context);
    expect(result.forbiddenTopics).toContain("#治疗挑食");
  });

  it("保持现有正文清洗方式并严格执行 29/30/31 字边界", () => {
    expect(
      countEffectiveBodyCharacters(
        `${"好".repeat(29)} #爱他美新手爸妈日记 https://example.com ，。！？`,
      ),
    ).toBe(29);

    const bodyRulePassed = (length: number) => {
      const note = createMockNote("passed");
      note.body = "好".repeat(length);
      const result = evaluateAudit(note, context);
      return {
        passed: result.ruleResults.find(
          (rule) => rule.ruleKey === "GLOBAL_BODY",
        )?.passed,
        failures: result.failureReasons,
      };
    };
    expect(bodyRulePassed(29)).toMatchObject({ passed: false });
    expect(bodyRulePassed(29).failures).toContain(
      "有效正文字数不足（29/30）",
    );
    expect(bodyRulePassed(30)).toMatchObject({ passed: true });
    expect(bodyRulePassed(31)).toMatchObject({ passed: true });
  });

  it("按已识别话题精确清洗开头、中间和结尾话题并保留普通正文", () => {
    const topics = ["#话题A", "#话题B"];
    expect(
      extractEffectiveBodyText("#话题A#话题B这是正文内容", topics),
    ).toBe("这是正文内容");
    expect(
      extractEffectiveBodyText(
        "前面的正文#话题A中间的正文#话题B后面的正文",
        topics,
      ),
    ).toBe("前面的正文 中间的正文 后面的正文");
    expect(
      extractEffectiveBodyText("这是正文内容#话题A#话题B", topics),
    ).toBe("这是正文内容");
    expect(countEffectiveBodyCharacters("#话题A#话题B", topics)).toBe(0);
  });

  it("开头连续真实话题后正文不再被计为0且话题审核保持通过", () => {
    const note = createMockNote("passed");
    const ordinaryBody = "好".repeat(30);
    const topicTexts = note.topics.map((topic) => topic.displayText);
    note.body = `${topicTexts.join("")}${ordinaryBody}`;

    const result = evaluateAudit(note, context);
    expect(result.effectiveBodyLength).toBe(30);
    expect(result.bodyCompliant).toBe(true);
    expect(result.missingTopics).toEqual([]);
    expect(result.autoStatus).toBe("PASSED");
    expect(
      result.ruleResults.find((rule) => rule.ruleKey === "GLOBAL_BODY"),
    ).toMatchObject({ passed: true, actualValue: "30 个有效正文字符" });
  });

  it("达能保持 30 字，佳贝艾特活动独立使用 50 字", () => {
    expect(MIN_BODY_LENGTH).toBe(30);
    expect(
      defaultRules.campaigns.find((campaign) => campaign.key === "activity_bd673ea91f342c12a819")
        ?.minBodyLength,
    ).toBe(30);
    expect(
      defaultRules.campaigns.find((campaign) => campaign.key === "activity_kabrita_2026_08")
        ?.minBodyLength,
    ).toBe(50);
  });

  it("佳贝艾特执行 50 字、3 图、对应产品标签和热门话题 4 选 2", () => {
    const campaign = defaultRules.campaigns.find(
      (item) => item.key === "activity_kabrita_2026_08",
    )!;
    const productKey = "product_kabrita_netherlands";
    const applicableRules = defaultRules.topicRules.filter(
      (rule) =>
        rule.campaignKey === campaign.key &&
        (!rule.productKey || rule.productKey === productKey) &&
        (!rule.applicableStage || rule.applicableStage === "IFFO_2"),
    );
    const kabritaContext: AuditContext = {
      productId: productKey,
      campaignId: campaign.key,
      campaignName: campaign.name,
      brandName: "佳贝艾特",
      basicRewardRequired: true,
      productStage: "IFFO_2",
      milkType: "IFFO",
      ruleVersion: campaign.ruleRevision,
      minImageCount: campaign.minImageCount,
      minBodyLength: campaign.minBodyLength,
      publicRequired: campaign.publicRequired,
      retentionDays: campaign.retentionDays,
      bodyRequired: campaign.bodyRequired,
      bodyStageRequired: false,
      clickableTopicRequired: campaign.clickableTopicRequired,
      rules: applicableRules.map((rule) => ({
        id: rule.key,
        scope: rule.scope,
        ruleType: rule.ruleType,
        topic: rule.topic,
        exactMatch: rule.exactMatch,
        clickableRequired: rule.clickableRequired,
        caseSensitive: rule.caseSensitive,
        minCount: rule.minCount,
        sortOrder: rule.sortOrder,
        version: rule.revision,
        topicCategory: rule.topicCategory,
        applicableStage: rule.applicableStage,
        milkType: rule.milkType,
      })),
    };
    const compliantNote = createMockNote("passed");
    compliantNote.body = "好".repeat(50);
    compliantNote.imageCount = 3;
    compliantNote.likeCount = 176;
    compliantNote.favoriteCount = 94;
    compliantNote.commentCount = 4;
    compliantNote.interactionExtractionStatus = "SUCCESS";
    compliantNote.topics = [
      "#初见小温柔成长更友好",
      "#佳贝艾特荷兰版",
      "#羊奶粉推荐婴儿",
      "#好消化吸收的奶粉",
    ].map((topic) => ({
      displayText: topic,
      isLinkElement: true,
      hasHref: true,
      href: `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(topic)}`,
      styleFeature: true,
    }));

    const rewardPassed = evaluateAudit(compliantNote, kabritaContext);
    expect(rewardPassed.autoStatus).toBe("PASSED");
    expect(
      rewardPassed.ruleResults.find(
        (rule) => rule.ruleKey === "KABRITA_BASIC_REWARD",
      ),
    ).toMatchObject({
      passed: true,
      actualValue: "点赞 176 + 收藏 94 + 评论 4 = 274",
    });

    const belowReward = structuredClone(compliantNote);
    belowReward.likeCount = 3;
    belowReward.favoriteCount = 3;
    belowReward.commentCount = 3;
    const belowRewardResult = evaluateAudit(belowReward, kabritaContext);
    expect(belowRewardResult.autoStatus).toBe("FAILED");
    expect(belowRewardResult.failureReasons).toContain(
      "基础奖励未达成：互动合计 9",
    );

    const thresholdReward = structuredClone(compliantNote);
    thresholdReward.likeCount = 5;
    thresholdReward.favoriteCount = 4;
    thresholdReward.commentCount = 1;
    expect(evaluateAudit(thresholdReward, kabritaContext).autoStatus).toBe(
      "PASSED",
    );

    const interactionUnavailable = structuredClone(compliantNote);
    interactionUnavailable.likeCount = null;
    interactionUnavailable.favoriteCount = null;
    interactionUnavailable.commentCount = null;
    interactionUnavailable.interactionExtractionStatus = "UNAVAILABLE";
    expect(
      evaluateAudit(interactionUnavailable, kabritaContext),
    ).toMatchObject({
      autoStatus: "NEEDS_REVIEW",
      failureReasons: ["基础奖励互动数据无法确认，需人工复核"],
    });

    const shortBody = structuredClone(compliantNote);
    shortBody.body = "好".repeat(49);
    const shortBodyResult = evaluateAudit(shortBody, kabritaContext);
    expect(shortBodyResult.autoStatus).toBe("FAILED");
    expect(shortBodyResult.failureReasons).toContain(
      "有效正文字数不足（49/50）",
    );
    expect(shortBodyResult.failureReasons.join("；")).not.toContain(
      "基础奖励未达成",
    );

    const fewImages = structuredClone(compliantNote);
    fewImages.imageCount = 2;
    expect(evaluateAudit(fewImages, kabritaContext).failureReasons).toContain(
      "图片数量不足（2/3）",
    );

    const onePopularTopic = structuredClone(compliantNote);
    onePopularTopic.topics = onePopularTopic.topics.filter(
      (topic) => topic.displayText !== "#好消化吸收的奶粉",
    );
    expect(
      evaluateAudit(onePopularTopic, kabritaContext).failureReasons,
    ).toContain("任意话题命中不足 2 个");

    const wrongProductTopic = structuredClone(compliantNote);
    wrongProductTopic.topics = wrongProductTopic.topics.map((topic) =>
      topic.displayText === "#佳贝艾特荷兰版"
        ? { ...topic, displayText: "#佳贝艾特港版" }
        : topic,
    );
    expect(evaluateAudit(wrongProductTopic, kabritaContext).missingTopics).toContain(
      "#佳贝艾特荷兰版",
    );

    const unavailablePage = structuredClone(compliantNote);
    unavailablePage.pageStatus = "NOTE_NOT_FOUND";
    expect(evaluateAudit(unavailablePage, kabritaContext).autoStatus).toBe(
      "NOTE_NOT_FOUND",
    );
  });

  it("只审核当前段位话题，且同名普通文本不能代替可点击话题", () => {
    const stageContext: AuditContext = {
      productId: "aptamil-white",
      campaignId: "aptamil-july",
      campaignName: "爱他美2026年7月小红书种草审核",
      productStage: "IFFO_2",
      milkType: "IFFO",
      ruleVersion: 1,
      minImageCount: 2,
      minBodyLength: MIN_BODY_LENGTH,
      publicRequired: true,
      retentionDays: 15,
      bodyRequired: true,
      bodyStageRequired: true,
      clickableTopicRequired: true,
      rules: [
        ["brand", "#爱他美新手爸妈日记", "BRAND_COMMON"],
        ["product", "#爱他美亲熠5HMO", "PRODUCT_COMMON"],
        ["stage", "#二段奶粉推荐", "PRODUCT_STAGE"],
      ].map(([id, topic, topicCategory], index) => ({
        id,
        scope: "CAMPAIGN",
        ruleType: "REQUIRED",
        topic,
        topicCategory,
        applicableStage:
          topicCategory === "PRODUCT_STAGE" ? "IFFO_2" : null,
        exactMatch: true,
        clickableRequired: true,
        caseSensitive: false,
        minCount: 1,
        sortOrder: index,
        version: 1,
      })),
    };
    const note = createMockNote("aptamil-passed");
    note.body = `宝宝目前喝2段奶粉，${"这是一段真实的产品体验内容".repeat(5)}`;
    note.imageCount = 2;
    note.isPublic = true;
    note.topics = stageContext.rules.map((rule) => ({
      displayText: rule.topic,
      isLinkElement: true,
      hasHref: true,
      href: `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(rule.topic)}`,
      textColor: "rgb(19, 92, 173)",
      styleFeature: true,
    }));

    const compliant = evaluateAudit(note, stageContext);
    expect(compliant.missingTopics).toEqual([]);
    expect(compliant.autoStatus).toBe("PASSED");
    expect(
      compliant.ruleResults.some((rule) => /图片|视觉/u.test(rule.ruleName)),
    ).toBe(true);
    expect(
      stageContext.rules.some((rule) => rule.topic === "#三段奶粉推荐"),
    ).toBe(false);
    expect(
      compliant.ruleResults.find(
        (rule) => rule.ruleKey === "PRODUCT_STAGE_BODY",
      ),
    ).toMatchObject({
      passed: true,
      actualValue: "2段",
    });

    note.topics = note.topics.map((topic) =>
      topic.displayText === "#二段奶粉推荐"
        ? {
            ...topic,
            isLinkElement: false,
            hasHref: false,
            href: null,
            styleFeature: false,
            domPath: "span.plain-topic",
            source: "DOM_TEXT",
          }
        : topic,
    );
    const plainTextOnly = evaluateAudit(note, stageContext);
    expect(plainTextOnly.autoStatus).toBe("FAILED");
    expect(plainTextOnly.missingTopics).not.toContain("#二段奶粉推荐");
    expect(plainTextOnly.failureReasons).toContain(
      "要求话题不可点击 #二段奶粉推荐",
    );
  });

  it("正文未出现当前产品阶段允许段位时给出独立失败原因", () => {
    const stageContext: AuditContext = {
      ...context,
      productStage: "GUM_3_4_1PLUS_2PLUS",
      bodyStageRequired: true,
      rules: [
        {
          id: "stage-gum",
          scope: "CAMPAIGN",
          ruleType: "REQUIRED",
          topic: "#三段奶粉推荐",
          topicCategory: "PRODUCT_STAGE",
          applicableStage: "GUM_3_4_1PLUS_2PLUS",
          exactMatch: true,
          clickableRequired: true,
          caseSensitive: false,
          minCount: 1,
          sortOrder: 1,
          version: 1,
        },
      ],
    };
    const note = createMockNote("passed");
    note.body = "宝宝目前喝2段奶粉，这是我们的真实体验记录。";
    note.topics = [
      {
        displayText: "#三段奶粉推荐",
        isLinkElement: true,
        hasHref: true,
        href: "https://www.xiaohongshu.com/search_result?keyword=gum",
        textColor: "rgb(19, 92, 173)",
        styleFeature: true,
      },
    ];
    const result = evaluateAudit(note, stageContext);
    expect(result.autoStatus).toBe("FAILED");
    expect(result.failureReasons).toContain(
      "正文段位不属于当前产品阶段话题：GUM 成长组（3段/4段/1+段/2+段）",
    );
    expect(result.failureReasons.join("；")).not.toContain("缺少阶段话题");
  });

  it("规则关闭正文段位校验后，正文没有段位词也不影响阶段话题审核", () => {
    const stageContext: AuditContext = {
      ...context,
      productStage: "IFFO_2",
      bodyStageRequired: false,
      rules: [
        {
          id: "stage-2",
          scope: "CAMPAIGN",
          ruleType: "REQUIRED",
          topic: "#二段奶粉推荐",
          topicCategory: "PRODUCT_STAGE",
          applicableStage: "IFFO_2",
          exactMatch: true,
          clickableRequired: true,
          caseSensitive: false,
          minCount: 1,
          sortOrder: 1,
          version: 1,
        },
      ],
    };
    const note = createMockNote("passed");
    note.body = "这是一次真实的喂养体验记录，正文不包含任何产品段位描述。".repeat(2);
    note.topics = [
      {
        displayText: "#二段奶粉推荐",
        isLinkElement: true,
        hasHref: true,
        href: "https://www.xiaohongshu.com/search_result?keyword=stage2",
        textColor: "rgb(19, 92, 173)",
        styleFeature: true,
      },
    ];
    const result = evaluateAudit(note, stageContext);
    expect(result.autoStatus).toBe("PASSED");
    expect(
      result.ruleResults.find(
        (rule) => rule.ruleKey === "PRODUCT_STAGE_BODY",
      ),
    ).toBeUndefined();
    expect(result.failureReasons.join("；")).not.toMatch(
      /正文未出现对应段位|正文段位不属于/u,
    );
  });

  it("近似阶段话题与精确话题缺失使用不同失败原因", () => {
    const stageContext: AuditContext = {
      ...context,
      productStage: "IFFO_P1",
      rules: [
        {
          id: "stage-p1",
          scope: "CAMPAIGN",
          ruleType: "REQUIRED",
          topic: "#新生儿奶粉",
          topicCategory: "PRODUCT_STAGE",
          applicableStage: "IFFO_P1",
          exactMatch: true,
          clickableRequired: true,
          caseSensitive: false,
          minCount: 1,
          sortOrder: 1,
          version: 1,
        },
      ],
    };
    const note = createMockNote("passed");
    note.body = "宝宝正在喝PRE段奶粉，这是我们的真实体验记录。";
    note.topics = [
      {
        displayText: "#新生儿奶粉推荐",
        isLinkElement: true,
        hasHref: true,
        href: "https://www.xiaohongshu.com/search_result?keyword=p1",
        textColor: "rgb(19, 92, 173)",
        styleFeature: true,
      },
    ];
    expect(evaluateAudit(note, stageContext).failureReasons.join("；")).toContain(
      "话题文字不准确",
    );
    note.topics = [];
    expect(evaluateAudit(note, stageContext).failureReasons.join("；")).toContain(
      "IFFO 新生儿组（P段/1段） 阶段话题未命中",
    );
  });

  it.each([
    ["#新生儿奶粉", "#二段奶粉推荐"],
    ["#二段奶粉推荐", "#新生儿奶粉"],
  ])("IFFO 命中 %s 时不要求同时出现 %s", (matched, absent) => {
    const stageContext: AuditContext = {
      ...context,
      productStage: "IFFO",
      bodyStageRequired: false,
      rules: [
        {
          id: "stage-p1",
          scope: "CAMPAIGN",
          ruleType: "REQUIRED",
          topic: "#新生儿奶粉",
          topicCategory: "PRODUCT_STAGE",
          applicableStage: "IFFO_P1",
          exactMatch: true,
          clickableRequired: true,
          caseSensitive: false,
          minCount: 1,
          sortOrder: 1,
          version: 1,
        },
        {
          id: "stage-2",
          scope: "CAMPAIGN",
          ruleType: "REQUIRED",
          topic: "#二段奶粉推荐",
          topicCategory: "PRODUCT_STAGE",
          applicableStage: "IFFO_2",
          exactMatch: true,
          clickableRequired: true,
          caseSensitive: false,
          minCount: 1,
          sortOrder: 2,
          version: 1,
        },
      ],
    };
    const note = createMockNote("passed");
    note.topics = [
      {
        displayText: matched,
        isLinkElement: true,
        hasHref: true,
        href: `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(matched)}`,
        styleFeature: true,
      },
    ];
    const result = evaluateAudit(note, stageContext);
    expect(result.autoStatus).toBe("PASSED");
    expect(result.missingTopics).toEqual([]);
    expect(result.failureReasons.join("；")).not.toContain(absent);
    expect(
      result.ruleResults.filter((rule) =>
        rule.ruleKey.startsWith("TOPIC_PRODUCT_STAGE_GROUP_"),
      ),
    ).toHaveLength(1);
  });

  it("IFFO 阶段候选均未命中时只生成一个 OR 组失败结论", () => {
    const stageContext: AuditContext = {
      ...context,
      productStage: "IFFO",
      bodyStageRequired: false,
      rules: ["#新生儿奶粉", "#二段奶粉推荐"].map((topic, index) => ({
        id: `stage-${index}`,
        scope: "CAMPAIGN",
        ruleType: "REQUIRED",
        topic,
        topicCategory: "PRODUCT_STAGE",
        applicableStage: index ? "IFFO_2" : "IFFO_P1",
        exactMatch: true,
        clickableRequired: true,
        caseSensitive: false,
        minCount: 1,
        sortOrder: index,
        version: 1,
      })),
    };
    const note = createMockNote("passed");
    note.topics = [];
    const result = evaluateAudit(note, stageContext);
    expect(result.autoStatus).toBe("FAILED");
    expect(result.failureReasons).toEqual([
      "IFFO 阶段话题未命中：#新生儿奶粉、#二段奶粉推荐 中至少出现 1 个",
    ]);
  });

  it("GUM 命中任一阶段候选时通过阶段话题审核", () => {
    const stageContext: AuditContext = {
      ...context,
      productStage: "GUM",
      bodyStageRequired: false,
      rules: ["#三段奶粉推荐", "#高段奶粉推荐"].map((topic, index) => ({
        id: `gum-${index}`,
        scope: "CAMPAIGN",
        ruleType: "REQUIRED",
        topic,
        topicCategory: "PRODUCT_STAGE",
        applicableStage: index ? "4段" : "GUM_3_4_1PLUS_2PLUS",
        exactMatch: true,
        clickableRequired: true,
        caseSensitive: false,
        minCount: 1,
        sortOrder: index,
        version: 1,
      })),
    };
    const note = createMockNote("passed");
    note.topics = [
      {
        displayText: "#三段奶粉推荐",
        isLinkElement: true,
        hasHref: true,
        href: "https://www.xiaohongshu.com/search_result?keyword=gum",
        styleFeature: true,
      },
    ];
    expect(evaluateAudit(note, stageContext).autoStatus).toBe("PASSED");
  });

  it("缺少目标话题时不误报蓝色可点击异常", () => {
    const missingContext: AuditContext = {
      ...context,
      bodyStageRequired: false,
      rules: [
        {
          id: "product-green",
          scope: "CAMPAIGN",
          ruleType: "REQUIRED",
          topic: "#爱他美奇迹绿罐",
          topicCategory: "PRODUCT_COMMON",
          exactMatch: true,
          clickableRequired: true,
          caseSensitive: false,
          minCount: 1,
          sortOrder: 1,
          version: 1,
        },
      ],
    };
    const note = createMockNote("passed");
    note.topics = ["#京东", "#新生儿奶粉", "#爱他美德国白金版"].map(
      (displayText) => ({
        displayText,
        isLinkElement: true,
        hasHref: true,
        href: `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(displayText)}`,
        textColor: "rgb(19, 92, 173)",
        styleFeature: true,
      }),
    );

    const result = evaluateAudit(note, missingContext);
    expect(result.topicsCompliant).toBe(false);
    expect(result.clickableCompliant).toBe(true);
    expect(result.missingTopics).toEqual(["#爱他美奇迹绿罐"]);
    expect(result.failureReasons).toContain("缺少精确话题 #爱他美奇迹绿罐");
  });
});
