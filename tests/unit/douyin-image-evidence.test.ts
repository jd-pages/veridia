import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { playwrightDouyinAdapter } from "@/lib/automation/douyin-adapter";

describe("抖音图文图片证据稳定性", () => {
  let browser: Browser | undefined;
  let page: Page;
  const contentId = "7658919904867844532";
  const canonicalUrl = `https://www.douyin.com/note/${contentId}`;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, channel: "chrome" });
    page = await browser.newPage();
    await page.route("https://cdn.example/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "image/gif",
        body: Buffer.from("R0lGODlhAQABAAAAACw=", "base64"),
      }),
    );
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
  }, 30_000);

  async function extract(structured?: Record<string, unknown>) {
    return playwrightDouyinAdapter.extract(page, canonicalUrl, {
      canonicalUrl,
      contentId,
      structured: structured
        ? { item: structured, responseUrl: canonicalUrl }
        : null,
    });
  }

  it("DOM 轮播按 slide 身份统计并排除头像与推荐图", async () => {
    await page.setContent(`
      <main data-e2e="note-detail">
        <img class="avatar" src="https://cdn.example/avatar.jpg">
        <div data-testid="douyin-image-carousel">
          <div data-swiper-slide-index="0"><img data-src="https://cdn.example/a.jpg"></div>
          <div data-swiper-slide-index="1"><img data-src="https://cdn.example/b.jpg"></div>
          <div data-swiper-slide-index="0"><img data-src="https://cdn.example/a-clone.jpg"></div>
        </div>
        <section class="recommend-list"><img src="https://cdn.example/recommend.jpg"></section>
        <div data-e2e="detail-desc">稳定图文正文 #产品话题</div>
      </main>
    `);
    const note = await extract();
    expect(note.imageCount).toBe(2);
    expect(note.imageExtractionStatus).toBe("SUCCESS");
  });

  it("结构化与 DOM 指向同一两张图片时不会累计成四张", async () => {
    await page.setContent(`
      <main data-e2e="note-detail">
        <div data-testid="douyin-image-carousel">
          <div data-index="0"><img src="https://cdn.example/a.jpg"></div>
          <div data-index="1"><img src="https://cdn.example/b.jpg"></div>
        </div>
        <div data-e2e="detail-desc">结构化与DOM双来源正文</div>
      </main>
    `);
    const note = await extract({
      aweme_id: contentId,
      images: [{ uri: "a" }, { uri: "b" }],
    });
    expect(note.imageCount).toBe(2);
    expect(note.pageEvidence).toMatchObject({
      structuredImageCount: 2,
      domImageCount: 2,
    });
  });

  it("lazy DOM 图片在证据连续稳定后得到最终两张", async () => {
    await page.setContent(`
      <main data-e2e="note-detail">
        <div id="carousel" data-testid="douyin-image-carousel">
          <div data-index="0"><img data-src="https://cdn.example/a.jpg"></div>
        </div>
        <div data-e2e="detail-desc">延迟轮播正文</div>
        <script>
          setTimeout(() => {
            document.querySelector('#carousel').insertAdjacentHTML(
              'beforeend',
              '<div data-index="1"><img data-src="https://cdn.example/b.jpg"></div>',
            );
          }, 220);
        </script>
      </main>
    `);
    expect((await extract()).imageCount).toBe(2);
  });

  it("同 contentId 的两种 DOM 变体都稳定得到两张", async () => {
    const variants = [
      `<div class="dySwiper"><div data-index="0"><img data-src="https://cdn.example/a.jpg"></div><div data-index="1"><img data-src="https://cdn.example/b.jpg"></div></div>`,
      `<div data-testid="douyin-image-carousel"><div data-swiper-slide-index="0"><source srcset="https://cdn.example/a.webp 1x"></div><div data-swiper-slide-index="1"><img data-original="https://cdn.example/b.webp"></div></div>`,
    ];
    const counts: number[] = [];
    for (const variant of variants) {
      await page.setContent(`<main data-e2e="note-detail">${variant}<div data-e2e="detail-desc">DOM变体正文</div></main>`);
      counts.push((await extract()).imageCount || 0);
    }
    expect(counts).toEqual([2, 2]);
  });

  it("Protected DOUYIN_PUBLIC_IMAGE_TEXT_CONTENT_ACCURACY：真实三张轮播不被十个 clone/preload img/source 放大且正文同源", async () => {
    await page.setContent(`
      <main data-e2e="note-detail">
        <section class="video-playing-item">
          <h3>爱他美澳洲白金版 当前作品完整正文
            <a data-douyin-topic href="/hashtag/1">#爱他美澳洲白金版</a>
            <a data-douyin-topic href="/hashtag/2">#三段奶粉推荐</a>
          </h3>
        </section>
        <div class="dySwiperSlide">
          <img src="https://cdn.example/1.webp"><img src="https://cdn.example/1-alt.webp">
          <video><source src="https://cdn.example/1-a.mp4"><source src="https://cdn.example/1-b.mp4"></video>
        </div>
        <div class="dySwiperSlide">
          <img src="https://cdn.example/2.webp"><img src="https://cdn.example/2-alt.webp">
          <video><source src="https://cdn.example/2.mp4"></video>
        </div>
        <div class="dySwiperSlide">
          <img src="https://cdn.example/3.webp"><img src="https://cdn.example/3-alt.webp">
          <video><source src="https://cdn.example/3.mp4"></video>
        </div>
        <div data-testid="douyin-carousel-pager">3/3</div>
        <section class="comment-list"><img src="https://cdn.example/comment.jpg">评论图片</section>
        <aside class="recommend-list"><div class="dySwiperSlide"><img src="https://cdn.example/recommend.jpg"></div>推荐正文</aside>
      </main>
    `);
    const note = await extract();
    expect(note).toMatchObject({
      imageCount: 3,
      body: expect.stringContaining("当前作品完整正文"),
    });
    expect(note.topics.map((topic) => topic.displayText)).toEqual([
      "#爱他美澳洲白金版",
      "#三段奶粉推荐",
    ]);
    expect(note.pageEvidence).toMatchObject({
      domImageCount: 3,
      domImageCountSource: "CAROUSEL_PAGER",
      domCarouselTotal: 3,
      logicalSlideCount: 3,
      finalImageCountSource: "CAROUSEL_PAGER",
    });
  });

  it("React Flight current detail 优先于十个 DOM 媒体节点并恢复结构化正文", async () => {
    const body = "只存在于 current React Flight detail 的完整正文 #当前话题";
    const detail = {
      awemeId: contentId,
      groupId: contentId,
      desc: body,
      images: [
        { uri: "structured-1" },
        { uri: "structured-2" },
        { uri: "structured-3" },
      ],
      textExtra: [{ hashtagName: "当前话题", hashtagId: "topic-1" }],
    };
    const flightValue = ["$", "$L9", null, {
      awemeId: contentId,
      aweme: { statusCode: 0, detail },
    }];
    const flightScript = `self.__pace_f.push(${JSON.stringify([
      1,
      `7:${JSON.stringify(flightValue)}`,
    ])})`;
    await page.setContent(`
      <main data-e2e="note-detail">
        <div class="dySwiperSlide"><img src="https://cdn.example/1.webp"><img src="https://cdn.example/1-alt.webp"><video><source src="https://cdn.example/1.mp4"></video></div>
        <div class="dySwiperSlide"><img src="https://cdn.example/2.webp"><img src="https://cdn.example/2-alt.webp"><video><source src="https://cdn.example/2.mp4"></video></div>
        <div class="dySwiperSlide"><img src="https://cdn.example/3.webp"><img src="https://cdn.example/3-alt.webp"><video><source src="https://cdn.example/3.mp4"></video></div>
        <aside class="recommend-list">推荐作品正文不得进入当前作品</aside>
      </main>
      <script>self.__pace_f = { push() {} };</script>
      <script>${flightScript}</script>
    `);
    const note = await extract();
    expect(note).toMatchObject({ body, imageCount: 3 });
    expect(note.pageEvidence).toMatchObject({
      source: "PAGE_STRUCTURED_DATA",
      structuredImageCount: 3,
      structuredImageSource: "aweme.images",
      finalImageCountSource: "STRUCTURED_IMAGE_LIST",
      bodySource: "STRUCTURED_DESC",
    });
  });
});
