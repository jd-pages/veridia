import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { PlaywrightXiaohongshuAdapter } from "@/lib/automation/adapters";

const noteUrl =
  "https://www.xiaohongshu.com/explore/6a7a91b00000000025014cd0";

describe("小红书 Live Photo current-note 统一取证", () => {
  let browser: Browser | undefined;
  let page: Page;
  const adapter = new PlaywrightXiaohongshuAdapter();

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, channel: "chrome" });
    page = await browser.newPage();
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
  }, 30_000);

  it("从同一作品容器读取标题、正文、话题、Live Photo、时间、公开状态和 8/4/10", async () => {
    await page.setContent(`
      <main id="noteContainer">
        <section class="swiper note-slider" data-testid="note-media">
          <div class="swiper-slide" data-swiper-slide-index="0">
            <img width="640" height="800" src="https://ci.example.com/live-1.jpg" />
            <div class="live-photo-badge">LIVE</div>
            <video muted poster="https://ci.example.com/live-1.jpg"><source src="https://ci.example.com/live-1.mp4" /></video>
          </div>
          <div class="swiper-slide" data-swiper-slide-index="1"><img width="640" height="800" src="https://ci.example.com/live-2.jpg" /></div>
          <div class="swiper-slide" data-swiper-slide-index="2"><img width="640" height="800" src="https://ci.example.com/live-3.jpg" /></div>
          <span class="pagination">1 / 3</span>
        </section>
        <h1 id="detail-title">快来，看宝宝举大桶🍼</h1>
        <div id="detail-desc">
          完整正文，不是空内容。
          <a id="hash-tag" href="/search_result?keyword=佳贝艾特荷兰版">#佳贝艾特荷兰版</a>
          <a href="/search_result?keyword=初见小温柔成长更友好">#初见小温柔成长更友好</a>
          <a href="/search_result?keyword=佳贝艾特羊奶粉">#佳贝艾特羊奶粉</a>
          <a href="/search_result?keyword=羊奶粉推荐婴儿">#羊奶粉推荐婴儿</a>
          <a href="/search_result?keyword=好消化吸收的奶粉">#好消化吸收的奶粉</a>
          <a href="/search_result?keyword=不易敏敏">#不易敏敏</a>
        </div>
        <span class="date">08-11 辽宁</span>
        <section class="comments-container"><div class="total">共 10 条评论</div><span class="like-wrapper"><span class="count">999</span></span></section>
        <div class="interactions engage-bar"><div class="buttons engage-bar-style"><div class="left">
          <span class="like-wrapper"><span class="count">8</span></span>
          <span class="collect-wrapper"><span class="count">4</span></span>
          <span class="chat-wrapper"><span class="count">10</span></span>
        </div></div></div>
      </main>
      <aside class="recommend-list">
        <h1 id="recommend-title">推荐作品标题</h1>
        <div class="note-desc">推荐正文污染</div>
        <a href="/search_result?keyword=推荐污染">#推荐污染</a>
        <img src="https://ci.example.com/recommend.jpg" />
        <span class="like-wrapper"><span class="count">888</span></span>
      </aside>
    `);

    const note = await adapter.extract(page, noteUrl);
    expect(note).toMatchObject({
      title: "快来，看宝宝举大桶🍼",
      noteType: "IMAGE_TEXT",
      imageExtractionStatus: "SUCCESS",
      imageCount: 3,
      publishedAtRaw: "08-11",
      pageStatus: "NORMAL",
      isPublic: true,
      likeCount: 8,
      favoriteCount: 4,
      commentCount: 10,
      interactionExtractionStatus: "SUCCESS",
    });
    expect(note.body).toContain("完整正文，不是空内容");
    expect(note.topics.map((topic) => topic.displayText)).toEqual([
      "#佳贝艾特荷兰版",
      "#初见小温柔成长更友好",
      "#佳贝艾特羊奶粉",
      "#羊奶粉推荐婴儿",
      "#好消化吸收的奶粉",
      "#不易敏敏",
    ]);
    expect(JSON.stringify(note.pageEvidence)).not.toContain("推荐污染");
    expect(note.pageEvidence?.publishedAtCandidate).toMatchObject({
      timeToken: "08-11",
      location: "辽宁",
    });
    expect(note.pageEvidence?.interactionEvidence).toMatchObject({
      totalCount: 22,
    });
    expect(note.pageEvidence?.mediaEvidence).toMatchObject({
      livePhotoMarker: true,
      carouselPageIndicator: "1/3",
      resolvedImageCount: 3,
    });
  }, 30_000);
});
