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
});
