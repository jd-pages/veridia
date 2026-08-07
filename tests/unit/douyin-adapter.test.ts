import { describe, expect, it } from "vitest";
import type { Page } from "playwright";
import {
  findDouyinAwemeItem,
  playwrightDouyinAdapter,
} from "@/lib/automation/douyin-adapter";

describe("抖音结构化作品证据", () => {
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
    });
    expect(note.topics).toEqual([
      expect.objectContaining({
        displayText: "#爱他美澳洲白金版",
        isLinkElement: true,
        hasHref: true,
        source: "NETWORK_STRUCTURED_DATA",
      }),
    ]);
    expect(note.pageEvidence?.structuredResponseUrl).toBe(
      "https://www.douyin.com/aweme/v1/web/aweme/post/",
    );
  });
});
