import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { readDouyinCurrentContentEvidence, waitForDouyinCurrentContentEvidence } from "@/lib/automation/douyin-current-content-evidence";
import { collectDouyinEvidence, findDouyinAwemeItem, playwrightDouyinAdapter } from "@/lib/automation/douyin-adapter";

const url = "https://www.douyin.com/note/222";
const currentBody = "当前作品的真实正文必须与当前图片发布时间和互动保持一致。#当前话题";
const fixture = fs.readFileSync(path.resolve("tests/regression/fixtures/douyin/visible-content-id-scope.html"), "utf8");
const detail = (id: string, content: string, attributes = "") => `<section data-testid="douyin-note-detail" data-content-id="${id}" ${attributes}><p data-testid="douyin-description">${content}</p><div data-testid="douyin-image-carousel"><span>1/3</span></div></section>`;

describe("抖音可见当前作品范围边界", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => { browser = await chromium.launch({ headless: true, channel: "chrome" }); }, 90_000);
  beforeEach(async () => { page = await browser.newPage(); });
  afterEach(async () => { await page?.close(); });
  afterAll(async () => { await browser?.close(); }, 30_000);

  async function load(html: string) {
    await page.route("https://www.douyin.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }));
    await page.goto(url);
  }

  it("Protected DOUYIN_VISIBLE_CONTENT_ID_SCOPE：隐藏旧详情与同 ID clone 不覆盖当前正文和三张图片", async () => {
    await load(fixture);
    const scope = await readDouyinCurrentContentEvidence(page, "222");
    expect(scope).toMatchObject({ scopeContentId: "222", contentIdInScope: true, contentIdMatches: true, hasContentEvidence: true });
    const dom = await collectDouyinEvidence(page, scope, "222");
    expect(dom).toMatchObject({ title: "当前作品标题", description: currentBody, imageCount: 3, logicalSlideCount: 3, carouselTotal: 3, scopeValid: true });
    expect(dom.description).not.toMatch(/旧|克隆/u);
    expect(dom.topics.map((topic) => topic.displayText)).toEqual(["#当前话题"]);
  });

  it.each(["hidden", "style='display:none'", "style='visibility:hidden'", "aria-hidden='true'", "inert"])(
    "%s 的旧详情不能遮蔽可见当前详情", async (hidden) => {
      await load(detail("111", "旧作品", hidden) + detail("222", "当前正文"));
      expect(await readDouyinCurrentContentEvidence(page, "222")).toMatchObject({ scopeContentId: "222", hasContentEvidence: true });
    },
  );

  it("SPA 只剩旧作品时不 ready，等待当前作品出现", async () => {
    await load(detail("111", "仍然可见的上一作品"));
    expect(await readDouyinCurrentContentEvidence(page, "222")).toMatchObject({ scopeKind: "NONE", contentIdMatches: false, hasContentEvidence: false });
    await page.evaluate((html) => { setTimeout(() => document.body.insertAdjacentHTML("beforeend", html), 250); }, detail("222", "当前作品终于出现"));
    const ready = await waitForDouyinCurrentContentEvidence(page, "222", 1500);
    expect(ready).toMatchObject({ scopeContentId: "222", hasContentEvidence: true });
    expect((await collectDouyinEvidence(page, ready, "222")).description).toBe("当前作品终于出现");
  });

  it("旧 readiness selector/index 不得在 SPA 切换后复用", async () => {
    await load(detail("222", "先前当前正文"));
    const stale = await readDouyinCurrentContentEvidence(page, "222");
    await page.evaluate((html) => { document.body.innerHTML = html; }, detail("111", "切换后的旧作品"));
    const evidence = await collectDouyinEvidence(page, stale, "222");
    expect(evidence).toMatchObject({ scopeValid: false, description: "", imageCount: 0, authorName: null, publishedAt: null });
    const extracted = await playwrightDouyinAdapter.extract(page, url, { contentId: "222", currentContentEvidence: stale });
    expect(extracted).toMatchObject({ pageStatus: "READ_FAILED", body: null, imageCount: 0 });
  });

  it("显式冲突父层不能通过无 ID 子详情绕过", async () => {
    await load(`<main data-content-id="111"><section data-e2e="note-detail"><p data-e2e="video-desc">旧父层正文</p></section></main>`);
    expect(await readDouyinCurrentContentEvidence(page, "222")).toMatchObject({ contentIdMatches: false, hasContentEvidence: false });
  });

  it("只有同 ID preload/clone 仍须等待主详情", async () => {
    await load(detail("222", "预加载不是主详情", "data-preload='true'") + detail("222", "clone不是主详情", "data-clone='true'"));
    expect(await readDouyinCurrentContentEvidence(page, "222")).toMatchObject({ scopeKind: "NONE", hasContentEvidence: false });
  });

  it("只有 current ID 的脚本和空根不是可审核内容", async () => {
    await load(`<main data-e2e="note-detail" data-content-id="222" style="width:500px;height:200px"></main><script type="application/json">{"aweme_id":"222"}</script>`);
    expect(await readDouyinCurrentContentEvidence(page, "222")).toMatchObject({ hasStructuredCurrentContent: true, hasContentEvidence: false });
    const result = await playwrightDouyinAdapter.extract(page, url, {
      contentId: "222", structured: { responseUrl: url, item: { aweme_id: "222" } },
    });
    expect(result).toMatchObject({ pageStatus: "READ_FAILED", body: null, imageCount: 0, publishedAt: null });
  });

  const structuredVariants: Array<{
    name: string;
    item: Record<string, unknown>;
    expected: Record<string, unknown>;
  }> = [
    ...["image_infos", "image_list", "imageInfos", "images_v2", "imagesV2"].map((key) => ({
      name: key,
      item: { [key]: [{ image_id: "current-1" }, { image_id: "current-2" }, { image_id: "current-2" }] },
      expected: { imageCount: 2, imageExtractionStatus: "SUCCESS" },
    })),
    ...["aweme_detail", "awemeDetail"].map((key) => ({
      name: `${key}.image_post_info.image_list`,
      item: { [key]: { image_post_info: { image_list: [{ image_id: "current-1" }, { image_id: "current-2" }, { image_id: "current-2" }] } } },
      expected: { imageCount: 2, imageExtractionStatus: "SUCCESS" },
    })),
    ...["publish_time", "publishTime"].map((key) => ({
      name: key,
      item: { [key]: 1786090851 },
      expected: { publishedAt: new Date(1786090851 * 1000).toISOString(), publishedAtSource: `DOUYIN_STRUCTURED:${key}` },
    })),
    ...["cha_list", "chaList", "hashtags", "hashtag_list", "hashtagList", "challenges"].map((key) => ({
      name: key,
      item: { [key]: [{ hashtag_name: "当前结构化话题", cha_name: "当前结构化话题" }] },
      expected: { topics: [{ displayText: "#当前结构化话题", isClickable: true, source: "STRUCTURED_RESPONSE" }] },
    })),
    ...[["share_info", "share_desc"], ["shareInfo", "shareDesc"]].map(([container, key]) => ({
      name: `${container}.${key}`,
      item: { [container]: { [key]: "当前结构化共享文案" } },
      expected: { body: "当前结构化共享文案" },
    })),
  ];

  it.each(structuredVariants)("结构化 payload 别名 $name 通过当前 ID gate 并实际提取", async ({ item, expected }) => {
    await load(`<main data-e2e="note-detail" data-content-id="222" style="width:500px;height:200px"></main>`);
    const result = await playwrightDouyinAdapter.extract(page, url, {
      contentId: "222", structured: { responseUrl: url, item: { aweme_id: "222", ...item } },
    });
    expect(result).toMatchObject({ pageStatus: "NORMAL", noteId: "222", ...expected });
    expect(result.pageEvidence).toMatchObject({ source: "NETWORK_STRUCTURED_DATA", currentContentEvidence: { hasContentEvidence: false } });
  });

  it("identity-only aweme wrapper 和无正文 share metadata 不成为结构化内容", async () => {
    await load(`<main data-e2e="note-detail" data-content-id="222" style="width:500px;height:200px"></main>`);
    const result = await playwrightDouyinAdapter.extract(page, url, {
      contentId: "222",
      structured: {
        responseUrl: url,
        item: { aweme_id: "222", aweme_detail: { aweme_id: "222" }, awemeDetail: { aweme_id: "222" }, share_info: { share_url: url } },
      },
    });
    expect(result).toMatchObject({ pageStatus: "READ_FAILED", body: null, imageCount: 0, publishedAt: null });
    expect(result.pageEvidence).toMatchObject({ source: "DOM" });
  });

  it.each(["aweme_detail", "awemeDetail", "image_post_info"])("父 current ID 和正文不能掩盖 %s 中的旧作品图片身份", async (key) => {
    await load(`<main data-e2e="note-detail" data-content-id="222" style="width:500px;height:200px"></main>`);
    const result = await playwrightDouyinAdapter.extract(page, url, {
      contentId: "222",
      structured: {
        responseUrl: url,
        item: {
          aweme_id: "222",
          desc: "父记录的 current ID 不能覆盖嵌套身份冲突",
          [key]: { aweme_id: "111", images: [{ image_id: "old-1" }, { image_id: "old-2" }] },
        },
      },
    });
    expect(result).toMatchObject({ pageStatus: "READ_FAILED", body: null, imageCount: 0 });
    expect(result.pageEvidence).toMatchObject({ source: "DOM", structuredImageCount: 0 });
  });

  it("结构化与 DOM 同 ID 时正文图片发布时间互动全来自当前作品", async () => {
    await load(fixture);
    const result = await playwrightDouyinAdapter.extract(page, url, { contentId: "222" });
    expect(result).toMatchObject({ pageStatus: "NORMAL", noteId: "222", title: "当前作品标题", body: currentBody, imageCount: 3, authorName: "当前作者", publishedAt: new Date(1786090851 * 1000).toISOString(), likeCount: 8, commentCount: 4, favoriteCount: 10, interactionExtractionStatus: "SUCCESS" });
    expect(result.pageEvidence).toMatchObject({ source: "PAGE_STRUCTURED_DATA", structuredImageCount: 3, domImageCount: 3 });
  });

  it("错误结构化 item 不得覆盖当前可见 DOM，也不能借其 current 标记混入另一 ID", async () => {
    await load(fixture.replace(/<script[\s\S]*?<\/script>/gu, ""));
    const result = await playwrightDouyinAdapter.extract(page, url, { contentId: "222", structured: { responseUrl: url, item: { aweme_id: "111", desc: "错误结构化正文", images: Array.from({ length: 10 }, () => ({})), statistics: { digg_count: 9999 } } } });
    expect(result).toMatchObject({ body: currentBody, imageCount: 3, likeCount: null });
    expect(findDouyinAwemeItem({ aweme_id: "222", item_id: "111", desc: "矛盾身份" }, "222")).toBeNull();
  });

  it.each(["/note/333", "/?modal_id=333"])("页面 URL %s 已变为其他 ID 时不接受旧 canonical 和结构化结果", async (otherUrl) => {
    await load(fixture);
    await page.evaluate((value) => history.replaceState(null, "", value), otherUrl);
    const result = await playwrightDouyinAdapter.extract(page, url, { contentId: "222", canonicalUrl: url, structured: { responseUrl: url, item: { aweme_id: "222", desc: "迟到的旧结构化结果", images: [{}, {}, {}] } } });
    expect(result).toMatchObject({ pageStatus: "READ_FAILED", body: null, imageCount: 0 });
  });
});
