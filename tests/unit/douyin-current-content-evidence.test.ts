import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import {
  readDouyinCurrentContentEvidence,
  waitForDouyinCurrentContentEvidence,
} from "@/lib/automation/douyin-current-content-evidence";
import { readDouyinPageIdentity } from "@/lib/automation/douyin-page-classification";

describe("抖音 current-content 统一证据", () => {
  let browser: Browser | undefined;
  let page: Page;
  let html = "";

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, channel: "chrome" });
    page = await browser.newPage();
    await page.route("https://www.douyin.com/**", (route) => route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: html,
    }));
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
  }, 30_000);

  async function load(path: string, body: string) {
    html = `<!doctype html><html><head><title>抖音作品</title></head><body>${body}</body></html>`;
    await page.goto(`https://www.douyin.com${path}`);
  }

  it("公开 /note/ 图文轮播未登录仍识别为 NORMAL / IMAGE_TEXT_DETAIL", async () => {
    const contentId = "7672632017595986041";
    await load(`/note/${contentId}`, `
      <main>
        <section data-testid="douyin-note-detail">
          <div data-testid="douyin-author">网络小妞</div>
          <p data-testid="douyin-description">当前作品正文 #当前话题</p>
          <div class="dySwiper">
            <div class="dySwiperSlide"><img src="a.jpg"></div>
            <div class="dySwiperSlide"><img src="b.jpg"></div>
          </div>
          <div data-e2e="video-player-digg">48</div>
          <div data-e2e="video-player-collect">1</div>
          <div data-e2e="feed-comment-icon">抢首评</div>
        </section>
        <aside>登录后查看更多评论，请扫码登录</aside>
      </main>
      <script id="RENDER_DATA" type="application/json">{"awemeId":"${contentId}"}</script>
    `);
    const identity = await readDouyinPageIdentity(
      page,
      200,
      `https://www.douyin.com/note/${contentId}`,
      contentId,
    );
    expect(identity).toMatchObject({
      state: "NORMAL",
      pageType: "IMAGE_TEXT_DETAIL",
      hasContentEvidence: true,
      contentIdMatches: true,
      currentContentEvidence: {
        scopeKind: "DATA_TESTID_NOTE_DETAIL",
        hasContentEvidence: true,
      },
    });
  });

  it("无显式 detail root 时只在完整当前轮播、作者和 action bar 同源时确认作品", async () => {
    const contentId = "7672632017595986041";
    await load(`/note/${contentId}`, `
      <main>
        <div class="dySwiper"><div class="dySwiperSlide"><img src="a.jpg"></div></div>
        <div data-e2e="user-info">网络小妞</div>
        <div data-e2e="video-player-digg">48</div>
        <div data-e2e="video-player-collect">1</div>
      </main>
      <script>self.__pace_f.push([1,"awemeId:${contentId}"])</script>
    `);
    expect(await readDouyinCurrentContentEvidence(page, contentId)).toMatchObject({
      scopeKind: "CURRENT_MEDIA_ANCESTOR",
      hasExplicitRoot: false,
      hasAuthor: true,
      hasStructuredCurrentContent: true,
      hasContentEvidence: true,
    });
  });

  it("全局 video 先出现时 readiness 继续等待真正 current-note root", async () => {
    const contentId = "7672632017595986041";
    await load(`/note/${contentId}`, `
      <video id="global-video"></video>
      <script>
        setTimeout(() => {
          document.body.insertAdjacentHTML("beforeend", \`
            <main data-e2e="note-detail">
              <div data-testid="douyin-description">延迟渲染的当前图文</div>
              <div class="dySwiper"><img data-testid="douyin-image" src="current.jpg"></div>
            </main>
          \`);
        }, 250);
      </script>
    `);
    const evidence = await waitForDouyinCurrentContentEvidence(
      page,
      contentId,
      2_000,
    );
    expect(evidence).toMatchObject({
      scopeKind: "DATA_E2E_NOTE_DETAIL",
      hasContentEvidence: true,
    });
  });

  it("公开 /video/ 继续识别为 NORMAL / VIDEO_DETAIL", async () => {
    const contentId = "7672632017595986000";
    await load(`/video/${contentId}`, `
      <main data-e2e="note-detail">
        <p data-e2e="video-desc">公开抖音视频正文</p>
        <video></video>
      </main>
    `);
    expect(await readDouyinPageIdentity(page, 200, null, contentId)).toMatchObject({
      state: "NORMAL",
      pageType: "VIDEO_DETAIL",
      hasContentEvidence: true,
    });
  });

  it("无显式 detail root 的当前播放器仍需作者和 action bar 共同确认", async () => {
    const contentId = "7672632017595986004";
    await load(`/video/${contentId}`, `
      <main>
        <div data-e2e="player-container"><video></video></div>
        <div data-e2e="user-info">视频作者</div>
        <div data-e2e="video-player-digg">8</div>
        <div data-e2e="video-player-collect">4</div>
      </main>
    `);
    expect(await readDouyinPageIdentity(page, 200, null, contentId)).toMatchObject({
      state: "NORMAL",
      pageType: "VIDEO_DETAIL",
      currentContentEvidence: {
        scopeKind: "CURRENT_MEDIA_ANCESTOR",
        hasContentEvidence: true,
      },
    });
  });

  it("/note/ 的不存在终态优先于作品 URL", async () => {
    const contentId = "7672632017595986001";
    await load(`/note/${contentId}`, "<main>你要观看的图文不存在</main>");
    expect(await readDouyinPageIdentity(page, 200, null, contentId)).toMatchObject({
      state: "NOTE_NOT_FOUND",
      pageType: "ERROR_PAGE",
    });
  });

  it("/note/ 的安全验证且无当前作品证据时保持 SECURITY_RESTRICTED", async () => {
    const contentId = "7672632017595986002";
    await load(`/note/${contentId}`, "<main>访问频繁，需要安全验证</main>");
    expect(await readDouyinPageIdentity(page, 200, null, contentId)).toMatchObject({
      state: "SECURITY_RESTRICTED",
      pageType: "SECURITY_CHECK",
      hasContentEvidence: false,
    });
  });

  it("只有评论区或推荐作品 video/轮播时不能误判当前作品", async () => {
    const contentId = "7672632017595986003";
    await load(`/note/${contentId}`, `
      <main>
        <aside class="recommend-list">
          <video></video>
          <div class="dySwiper"><img src="recommend.jpg"></div>
          <span>推荐作品点赞 9999</span>
        </aside>
        <section class="comment-list"><span>评论区视频 88</span></section>
      </main>
      <script id="RENDER_DATA" type="application/json">{"awemeId":"${contentId}"}</script>
    `);
    const evidence = await readDouyinCurrentContentEvidence(page, contentId);
    expect(evidence).toMatchObject({
      scopeKind: "NONE",
      carouselMarkerCount: 0,
      videoCount: 0,
      hasStructuredCurrentContent: true,
      hasContentEvidence: false,
    });
    expect(await readDouyinPageIdentity(page, 200, null, contentId)).toMatchObject({
      state: "UNKNOWN",
      hasContentEvidence: false,
    });
  });
});
