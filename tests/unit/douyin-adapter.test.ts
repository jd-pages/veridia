import { describe, expect, it } from "vitest";
import type { Page } from "playwright";
import {
  extractDouyinStructuredTopics,
  extractDouyinStructuredPublishedAt,
  findDouyinAwemeItem,
  findDouyinAwemeItemFromSerializedPayloads,
  playwrightDouyinAdapter,
} from "@/lib/automation/douyin-adapter";

describe("抖音结构化作品证据", () => {
  it("只从当前 contentId 对应作品读取结构化发布时间", () => {
    const payload = {
      aweme_list: [
        { aweme_id: "other", create_time: 1_700_000_000 },
        { aweme_id: "target", publish_time: 1_786_071_651 },
      ],
    };
    const target = findDouyinAwemeItem(payload, "target");
    expect(target).not.toBeNull();
    expect(extractDouyinStructuredPublishedAt(target!, "target")).toMatchObject({
      raw: expect.stringMatching(/^2026-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u),
      source: "DOUYIN_STRUCTURED:publish_time",
      contentId: "target",
    });
    expect(findDouyinAwemeItem(payload, "missing")).toBeNull();
  });
  it("从作品列表中精确选择目标 contentId，而不是取最新作品", () => {
    const target = findDouyinAwemeItem({
      aweme_list: [
        { aweme_id: "newest", desc: "最新作品" },
        {
          aweme_id: "7657479531817806068",
          desc: "目标图文正文",
          images: [{}, {}],
          text_extra: [
            { type: 1, hashtag_name: "爱他美澳洲白金版" },
          ],
        },
      ],
    }, "7657479531817806068");

    expect(target).toMatchObject({
      aweme_id: "7657479531817806068",
      desc: "目标图文正文",
    });
  });

  it("目标不存在时不错误使用其他作品", () => {
    expect(findDouyinAwemeItem({
      aweme_list: [{ aweme_id: "other" }],
    }, "missing")).toBeNull();
  });

  it("/note 路径即使存在 video 元素仍按图文及结构化证据提取", async () => {
    const page = {
      locator: () => ({ textContent: async () => null }),
      evaluate: async () => ({
        title: "真实图文标题",
        description: "",
        topics: [],
        hasVideo: true,
        imageCount: 20,
        authorName: null,
        publishedAt: null,
        structuredPayloads: [],
        visibleText: "",
      }),
      title: async () => "真实图文标题 - 抖音",
      url: () => "https://www.douyin.com/note/7658919904867844532",
    } as unknown as Page;

    const note = await playwrightDouyinAdapter.extract(
      page,
      "9.99 复制打开抖音 https://v.douyin.com/Nq9CA-bGmaY/",
      {
        canonicalUrl: "https://www.douyin.com/note/7658919904867844532",
        contentId: "7658919904867844532",
        structured: {
          responseUrl: "https://www.douyin.com/aweme/v1/web/aweme/post/?token=secret",
          item: {
            aweme_id: "7658919904867844532",
            desc: "真实图文正文",
            create_time: 1_786_071_651,
            author: { nickname: "真实作者" },
            images: [{}, {}, {}],
            video: { play_addr: {} },
            text_extra: [
              { type: 1, hashtag_name: "爱他美澳洲白金版" },
            ],
          },
        },
      },
    );

    expect(note).toMatchObject({
      noteId: "7658919904867844532",
      noteType: "IMAGE_TEXT",
      body: "真实图文正文",
      authorName: "真实作者",
      imageCount: 3,
      pageType: "IMAGE_TEXT_DETAIL",
      publishedAtRaw: expect.stringMatching(/^2026-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u),
      publishedAtSource: "DOUYIN_STRUCTURED:create_time",
    });
    expect(note.pageEvidence?.publishedAtCandidate).toMatchObject({
      contentId: "7658919904867844532",
      source: "DOUYIN_STRUCTURED:create_time",
    });
    expect(note.topics).toEqual([
      expect.objectContaining({
        displayText: "#爱他美澳洲白金版",
        isClickable: true,
        isLinkElement: false,
        hasHref: true,
        source: "STRUCTURED_RESPONSE",
      }),
    ]);
    expect(note.pageEvidence?.structuredResponseUrl).toBe(
      "https://www.douyin.com/aweme/v1/web/aweme/post/",
    );
  });

  it("从 URL 编码的页面脚本中按 contentId 精确恢复正文和作品", () => {
    const serialized = encodeURIComponent(JSON.stringify({
      state: {
        aweme_list: [
          { aweme_id: "other", desc: "其他作品" },
          {
            aweme_id: "7663387047995111417",
            desc: "哎呦喂鹅，这是一段真实图文作品正文，必须从目标作品结构化数据提取。",
          },
        ],
      },
    }));
    expect(findDouyinAwemeItemFromSerializedPayloads(
      [serialized],
      "7663387047995111417",
    )).toMatchObject({
      aweme_id: "7663387047995111417",
      desc: expect.stringContaining("真实图文作品正文"),
    });
  });

  it("只接受结构化 hashtag/challenge 实体，不从正文中的井号文字猜话题", () => {
    const topics = extractDouyinStructuredTopics({
      desc: "普通正文里写了 #不可据此判定的话题",
      text_extra: [
        { type: 1, hashtag_name: "爱他美澳洲白金版", hashtag_id: "1" },
      ],
      cha_list: [
        { cha_name: "二段奶粉推荐", cid: "2" },
      ],
      hashtags: [
        { name: "FOLO海外旗舰店", id: "3" },
        { name: "爱他美澳洲白金版", id: "1" },
      ],
    });
    expect(topics.map((topic) => topic.displayText)).toEqual([
      "#爱他美澳洲白金版",
      "#二段奶粉推荐",
      "#FOLO海外旗舰店",
    ]);
    expect(topics.every((topic) => topic.isClickable && topic.hasHref)).toBe(true);
    expect(extractDouyinStructuredTopics({
      desc: "只有 #普通正文话题，没有结构化话题实体",
    })).toEqual([]);
  });

  it("网络详情缺失时使用页面内结构化脚本恢复重点短链图文的正文和真实话题", async () => {
    const contentId = "7663387047995111417";
    const body = "哎呦喂鹅，这是一段来自页面结构化脚本的完整图文正文，不再因为只有页面标题而被判定正文为空。";
    const structuredPayload = encodeURIComponent(JSON.stringify({
      loaderData: {
        aweme_list: [{
          aweme_id: contentId,
          desc: body,
          images: [{}, {}, {}],
          text_extra: [
            { type: 1, hashtag_name: "爱他美澳洲白金版", hashtag_id: "11" },
            { type: 1, hashtag_name: "二段奶粉推荐", hashtag_id: "12" },
          ],
        }],
      },
    }));
    const page = {
      locator: () => ({ textContent: async () => null }),
      evaluate: async () => ({
        title: "哎呦喂鹅",
        titleSource: "DOCUMENT_TITLE",
        description: "",
        descriptionSource: null,
        topics: [{
          displayText: "#爱他美澳洲白金版",
          isClickable: true,
          isLinkElement: true,
          hasHref: true,
          href: "https://www.douyin.com/search/爱他美澳洲白金版",
          styleFeature: true,
          source: "DOM",
        }],
        hasVideo: false,
        imageCount: 3,
        authorName: null,
        publishedAt: null,
        structuredPayloads: [structuredPayload],
        visibleText: "",
      }),
      title: async () => "哎呦喂鹅 - 抖音",
      url: () => `https://www.douyin.com/note/${contentId}`,
    } as unknown as Page;
    const note = await playwrightDouyinAdapter.extract(
      page,
      "https://v.douyin.com/BuFG6kUNmFQ/",
      {
        canonicalUrl: `https://www.douyin.com/note/${contentId}`,
        contentId,
      },
    );
    expect(note).toMatchObject({
      noteId: contentId,
      noteType: "IMAGE_TEXT",
      body,
      imageCount: 3,
    });
    expect(note.topics.map((topic) => topic.displayText)).toEqual([
      "#爱他美澳洲白金版",
      "#二段奶粉推荐",
    ]);
    expect(note.pageEvidence).toMatchObject({
      source: "PAGE_STRUCTURED_DATA",
      structuredEvidenceSource: "PAGE_SCRIPT",
      finalTopicCount: 2,
    });
  });

  it.each([
    ["https://www.douyin.com/note/7663387047995111417", "IMAGE_TEXT"],
    ["https://www.douyin.com/video/7663387047995111417", "VIDEO"],
  ] as const)("%s 使用结构化 caption 作为正文并保留作品类型", async (url, noteType) => {
    const page = {
      locator: () => ({ textContent: async () => null }),
      evaluate: async () => ({
        title: "页面标题摘要",
        titleSource: "DOCUMENT_TITLE",
        description: "",
        descriptionSource: null,
        topics: [],
        hasVideo: noteType === "VIDEO",
        imageCount: noteType === "IMAGE_TEXT" ? 3 : 0,
        authorName: null,
        publishedAt: null,
        structuredPayloads: [],
        visibleText: "",
      }),
      title: async () => "页面标题摘要 - 抖音",
      url: () => url,
    } as unknown as Page;
    const caption = "这是完整作品正文，标题摘要不能替代正文，正文需要独立保存并参与字符计数。";
    const note = await playwrightDouyinAdapter.extract(page, url, {
      canonicalUrl: url,
      contentId: "7663387047995111417",
      structured: {
        responseUrl: "https://www.douyin.com/aweme/v1/web/aweme/detail/",
        source: "NETWORK_RESPONSE",
        item: {
          aweme_id: "7663387047995111417",
          caption,
          ...(noteType === "IMAGE_TEXT" ? { images: [{}, {}, {}] } : {}),
        },
      },
    });
    expect(note.noteType).toBe(noteType);
    expect(note.title).toBe("页面标题摘要");
    expect(note.body).toBe(caption);
  });

  it("结构化作品和页面都没有 caption 时保持 body 为空", async () => {
    const url = "https://www.douyin.com/video/7663387047995111417";
    const page = {
      locator: () => ({ textContent: async () => null }),
      evaluate: async () => ({
        title: "无正文作品",
        titleSource: "DOCUMENT_TITLE",
        description: "",
        descriptionSource: null,
        topics: [],
        hasVideo: true,
        imageCount: 0,
        authorName: null,
        publishedAt: null,
        structuredPayloads: [],
        visibleText: "",
      }),
      title: async () => "无正文作品 - 抖音",
      url: () => url,
    } as unknown as Page;
    const note = await playwrightDouyinAdapter.extract(page, url, {
      canonicalUrl: url,
      contentId: "7663387047995111417",
      structured: {
        responseUrl: "https://www.douyin.com/aweme/v1/web/aweme/detail/",
        item: { aweme_id: "7663387047995111417", desc: "" },
      },
    });
    expect(note.body).toBeNull();
    expect(note.technicalWarnings).not.toContain("BODY_NOT_RECOGNIZED");
  });
});
