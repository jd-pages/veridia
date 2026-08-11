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
});
