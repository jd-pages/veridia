import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { PlaywrightXiaohongshuAdapter } from "@/lib/automation/adapters";

describe("xiaohongshu image count extractor", () => {
  let browser: Browser;
  let page: Page;
  const adapter = new PlaywrightXiaohongshuAdapter();

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, channel: "chrome" });
    page = await browser.newPage();
  }, 30_000);

  afterAll(async () => {
    await browser.close();
  }, 30_000);

  it("只统计轮播媒体，按轮播页去重并排除头像、评论和推荐图", async () => {
    await page.setContent(`
      <main>
        <img class="avatar" src="https://cdn.example/avatar.jpg">
        <section class="swiper-container" data-testid="note-media">
          <div class="swiper-slide" data-swiper-slide-index="0">
            <picture>
              <source srcset="https://cdn.example/note-1.webp 1x, https://cdn.example/note-1@2x.webp 2x">
              <img data-original="https://cdn.example/note-1.jpg" src="https://cdn.example/note-1-thumb.jpg">
            </picture>
          </div>
          <div class="swiper-slide" data-swiper-slide-index="1"
               style="background-image:url('https://cdn.example/note-2.jpg')"></div>
          <div class="swiper-slide swiper-slide-duplicate" data-swiper-slide-index="0">
            <img data-src="https://cdn.example/note-1-clone.jpg">
          </div>
        </section>
        <section class="comment-list"><img src="https://cdn.example/comment.jpg"></section>
        <section class="recommend-list"><img src="https://cdn.example/recommend.jpg"></section>
        <div id="detail-desc">这是正常正文内容。</div>
      </main>
    `, { waitUntil: "domcontentloaded" });

    const result = await adapter.extract(
      page,
      "https://www.xiaohongshu.com/explore/test-note",
    );
    expect(result.noteType).toBe("IMAGE_TEXT");
    expect(result.imageExtractionStatus).toBe("SUCCESS");
    expect(result.imageCount).toBe(2);
    expect(result.imageUrls).toBeUndefined();
  });

  it("treats a LIVE 1/3 carousel as a three-image note", async () => {
    await page.setContent(`
      <main>
        <section class="swiper-container live-photo-container" data-testid="note-media">
          <span class="live-photo-badge">LIVE</span>
          <span class="swiper-pagination">1/3</span>
          <div class="swiper-slide" data-swiper-slide-index="0">
            <picture><img src="https://cdn.example/live-note-1.jpg"></picture>
            <video muted autoplay aria-label="LIVE photo motion layer"></video>
          </div>
        </section>
        <div id="detail-desc">LIVE 实况图仍然属于图文轮播，并且图片数量需要正常参与审核。</div>
      </main>
    `, { waitUntil: "domcontentloaded" });

    const result = await adapter.extract(
      page,
      "https://www.xiaohongshu.com/explore/live-photo-note",
    );
    expect(result.noteType).toBe("IMAGE_TEXT");
    expect(result.imageExtractionStatus).toBe("SUCCESS");
    expect(result.imageCount).toBe(3);
    expect(result.pageEvidence).toMatchObject({
      mediaEvidence: {
        livePhotoMarker: true,
        carouselPageIndicator: "1/3",
        carouselTotal: 3,
        carouselStructure: true,
        domImageCandidateCount: 1,
        domHasVideo: true,
        videoCandidateCount: 1,
        videoEvidence: expect.arrayContaining([
          "VIDEO_ELEMENT",
          "VIDEO_ATTRIBUTES",
        ]),
        noteTypeDecision: "IMAGE_TEXT",
        noteTypeReason: "IMAGE_CAROUSEL",
        resolvedImageCount: 3,
      },
    });
  });

  it("视频笔记标记 VIDEO_NOTE，不保存 0 张", async () => {
    await page.setContent(`
      <main>
        <div data-testid="note-media" class="video-player"><video></video></div>
        <div id="detail-desc">视频笔记正文。</div>
      </main>
    `, { waitUntil: "domcontentloaded" });
    const result = await adapter.extract(
      page,
      "https://www.xiaohongshu.com/explore/video-note",
    );
    expect(result.noteType).toBe("VIDEO_NOTE");
    expect(result.imageExtractionStatus).toBe("VIDEO_NOTE");
    expect(result.imageCount).toBeUndefined();
  });

  it("正文实际 4 张时忽略页面 JSON 的推荐图并按稳定轮播页去重", async () => {
    const recommendationImages = Array.from(
      { length: 36 },
      (_, index) => ({ cover: { url: `https://cdn.example/recommend-${index}.jpg` } }),
    );
    await page.setContent(`
      <main>
        <img class="avatar" src="https://cdn.example/avatar.jpg">
        <img class="logo" src="https://cdn.example/logo.png">
        <section class="swiper-container" data-testid="note-media">
          ${Array.from(
            { length: 4 },
            (_, index) => `
              <div class="swiper-slide" data-swiper-slide-index="${index}">
                <picture>
                  <source srcset="https://cdn.example/note-${index + 1}.jpg?width=320 1x, https://cdn.example/note-${index + 1}.jpg?width=1280 2x">
                  <img src="https://cdn.example/note-${index + 1}.jpg?x-oss-process=resize">
                </picture>
              </div>`,
          ).join("")}
          <div class="swiper-slide swiper-slide-duplicate" data-swiper-slide-index="0">
            <img src="https://cdn.example/note-1.jpg?width=640">
          </div>
        </section>
        <section class="comment-list"><img src="https://cdn.example/comment.jpg"></section>
        <section class="recommend-list"><img src="https://cdn.example/recommend.jpg"></section>
        <script type="application/ld+json">${JSON.stringify({ recommendationImages })}</script>
        <div id="detail-desc">这是包含四张正文图片的笔记。</div>
      </main>
    `, { waitUntil: "domcontentloaded" });

    const result = await adapter.extract(
      page,
      "https://www.xiaohongshu.com/explore/four-image-note",
    );
    expect(result.imageExtractionStatus).toBe("SUCCESS");
    expect(result.imageCount).toBe(4);
  });

  it("页面正常但无法确认媒体数量时标记待人工复核状态", async () => {
    await page.setContent(`
      <main>
        <div id="detail-desc">正文和话题均可读取，但没有可确认的轮播结构。</div>
      </main>
    `, { waitUntil: "domcontentloaded" });
    const result = await adapter.extract(
      page,
      "https://www.xiaohongshu.com/explore/unknown-media",
    );
    expect(result.noteType).toBe("UNKNOWN");
    expect(result.imageExtractionStatus).toBe("IMAGES_READ_FAILED");
    expect(result.imageCount).toBeUndefined();
  });

  it("兼容当前详情容器并同时提取笔记 ID、正文、话题和图片候选", async () => {
    await page.setContent(`
      <main>
        <section class="note-detail-container-v2">
          <h1 class="note-title-v2">真实体验记录</h1>
          <div class="note-desc-v2">
            正文内容超过四十一个有效字符，用于验证新页面结构下正文仍能稳定完成自动提取。
            <a href="/search_result?keyword=新生儿奶粉">#新生儿奶粉</a>
            <a href="/topic/爱他美新手爸妈日记">#爱他美新手爸妈日记</a>
          </div>
          <div class="media-container-v2 swiper-v2">
            <div class="swiper-slide" data-swiper-slide-index="0"><img data-src="https://ci.example.com/1.jpg"></div>
            <div class="swiper-slide" data-swiper-slide-index="1"><picture><source srcset="https://ci.example.com/2.webp 1x"></picture></div>
          </div>
        </section>
      </main>
    `, { waitUntil: "domcontentloaded" });
    const result = await adapter.extract(
      page,
      "https://www.xiaohongshu.com/discovery/item/6a5cb375000000000301c549",
    );
    expect(result.noteId).toBe("6a5cb375000000000301c549");
    expect(result.body).toContain("正文内容超过四十一个有效字符");
    expect(result.topics.map((item) => item.displayText)).toEqual(
      expect.arrayContaining(["#新生儿奶粉", "#爱他美新手爸妈日记"]),
    );
    expect(result.topics.every((item) => item.hasHref)).toBe(true);
    expect(result.imageExtractionStatus).toBe("SUCCESS");
    expect(result.imageCount).toBe(2);
    expect(result.pageEvidence).toMatchObject({ htmlLength: expect.any(Number) });
  }, 20_000);
});
