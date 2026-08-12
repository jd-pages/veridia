import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { PlaywrightXiaohongshuAdapter } from "@/lib/automation/adapters";

describe("小红书当前作品 DOM 话题证据", () => {
  let browser: Browser | undefined;
  let page: Page;
  const adapter = new PlaywrightXiaohongshuAdapter();
  const noteUrl =
    "https://www.xiaohongshu.com/explore/6a5cb375000000000301c549";

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, channel: "chrome" });
    page = await browser.newPage();
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
  }, 30_000);

  it("正文纯文本 hashtag 只进入诊断候选，不能进入 verified topics", async () => {
    await page.setContent(`
      <article data-testid="note-detail">
        <div id="detail-desc">宝宝喝得不错 #三段奶粉推荐</div>
      </article>
    `);
    const note = await adapter.extract(page, noteUrl);
    expect(note.body).toContain("#三段奶粉推荐");
    expect(note.textHashtagCandidates?.map((topic) => topic.displayText)).toEqual([
      "#三段奶粉推荐",
    ]);
    expect(note.verifiedPlatformTopics).toEqual([]);
    expect(note.topics).toEqual([]);
    expect(note.topicEvidenceCollected).toBe(true);
  });

  it("当前正文区域真实可点击话题进入 verified topics", async () => {
    await page.setContent(`
      <article data-testid="note-detail">
        <div id="detail-desc">
          正文 <a class="topic" href="/search_result?keyword=三段奶粉推荐">#三段奶粉推荐</a>
        </div>
      </article>
    `);
    const note = await adapter.extract(page, noteUrl);
    expect(note.verifiedPlatformTopics).toEqual([
      expect.objectContaining({
        displayText: "#三段奶粉推荐",
        isClickable: true,
        source: "DOM_LINK",
      }),
    ]);
    expect(note.topics.map((topic) => topic.displayText)).toEqual([
      "#三段奶粉推荐",
    ]);
  });

  it("纯文本 A 与可点击 B 保持隔离", async () => {
    await page.setContent(`
      <article data-testid="note-detail">
        <div id="detail-desc">
          正文 #A <a class="topic" href="/search_result?keyword=B">#B</a>
        </div>
      </article>
    `);
    const note = await adapter.extract(page, noteUrl);
    expect(note.textHashtagCandidates?.map((topic) => topic.displayText)).toEqual(
      expect.arrayContaining(["#A", "#B"]),
    );
    expect(note.topics.map((topic) => topic.displayText)).toEqual(["#B"]);
  });

  it("评论和推荐区域里的可点击话题不属于当前作品", async () => {
    await page.setContent(`
      <article data-testid="note-detail">
        <div id="detail-desc">当前作品正文</div>
        <section class="comment-list">
          <a href="/search_result?keyword=评论话题">#评论话题</a>
        </section>
        <section class="recommend-list">
          <a href="/search_result?keyword=推荐话题">#推荐话题</a>
        </section>
      </article>
    `);
    const note = await adapter.extract(page, noteUrl);
    expect(note.topics).toEqual([]);
  });
});
