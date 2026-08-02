import { describe, expect, it } from "vitest";
import {
  countEffectiveBodyCharacters,
  evaluateAudit,
} from "@/lib/audit-engine";
import { createMockNote } from "@/lib/mock-data";
import type { AuditContext } from "@/lib/types";

const context: AuditContext = {
  productId: "p1",
  campaignId: "c1",
  campaignName: "测试活动",
  ruleVersion: 3,
  minImageCount: 2,
  minBodyLength: 1,
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
  it("话题技术读取失败时保留正文结论并进入待人工复核", () => {
    const note = createMockNote("no-topics");
    note.body = "这是一段长度足够且可以正常参与固定规则审核的正文内容。";
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
    ...["search_result", "tag", "topic", "explore", "hashtag", "keyword"].map(
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

  it("候选存在但交互证据不完整时进入待人工复核", () => {
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
    expect(result.autoStatus).toBe("NEEDS_REVIEW");
    expect(result.clickableCompliant).toBe(true);
    expect(result.failureReasons.join("；")).not.toContain("要求话题不可点击");
    expect(
      result.ruleResults.find((rule) => rule.ruleKey === "TOPIC_r1"),
    ).toMatchObject({
      passed: true,
      actualValue: "精确出现，可点击状态需人工确认",
    });
  });

  it("识别禁止话题", () => {
    const result = evaluateAudit(createMockNote("failed"), context);
    expect(result.forbiddenTopics).toContain("#治疗挑食");
  });

  it("正文字数排除话题、链接、空白和纯标点，并严格执行至少 41 字", () => {
    expect(
      countEffectiveBodyCharacters(
        `${"好".repeat(40)} #爱他美新手爸妈日记 https://example.com ，。！？`,
      ),
    ).toBe(40);
    expect(countEffectiveBodyCharacters("好".repeat(41))).toBe(41);
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
      minBodyLength: 41,
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
      "正文段位不属于当前产品阶段话题：GUM：3段/4段/1+段/2+段",
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
    note.body = "这是一次真实的喂养体验记录，正文不包含任何产品段位描述。";
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
    expect(evaluateAudit(note, stageContext).failureReasons).toContain(
      "缺少精确话题 #新生儿奶粉",
    );
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
