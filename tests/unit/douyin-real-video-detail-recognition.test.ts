import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import {
  readDouyinCurrentContentEvidence,
  type DouyinStructuredTargetEvidence,
} from "@/lib/automation/douyin-current-content-evidence";
import { readDouyinPageIdentity } from "@/lib/automation/douyin-page-classification";

const CONTENT_A = "7680362613540700006";
const CONTENT_B = "7680362613540700999";
const REAL_SHAPE_FIXTURE = fs.readFileSync(
  path.resolve("tests/regression/fixtures/douyin/real-video-detail-current-player.html"),
  "utf8",
);
const DESKTOP_CACHE_FIXTURE = fs.readFileSync(
  path.resolve("tests/regression/fixtures/douyin/desktop-runtime-network-cache-video.html"),
  "utf8",
);

const structured = (
  contentId: string,
  hasPayload = true,
): DouyinStructuredTargetEvidence => ({
  contentId,
  hasPayload,
  source: "NETWORK_RESPONSE",
});

describe("抖音真实 video detail current-content 识别", () => {
  let browser: Browser | undefined;
  let page: Page;
  let html = "";

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, channel: "chrome" });
    page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await page.route("https://www.douyin.com/**", (route) => route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: html,
    }));
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
  }, 30_000);

  async function load(body: string, contentId = CONTENT_A) {
    html = body;
    await page.goto(`https://www.douyin.com/video/${contentId}`);
  }

  async function identity(
    contentId = CONTENT_A,
    targetEvidence: DouyinStructuredTargetEvidence | null = null,
  ) {
    const evidence = await readDouyinCurrentContentEvidence(
      page,
      contentId,
      targetEvidence,
    );
    return readDouyinPageIdentity(page, 200, null, contentId, evidence);
  }

  it("Protected DOUYIN_REAL_VIDEO_DETAIL_RECOGNITION：真实新播放器结构以目标绑定证据识别且漂移内容继续 fail closed", async () => {
    await load(REAL_SHAPE_FIXTURE);
    expect(await identity(CONTENT_A, structured(CONTENT_A))).toMatchObject({
      state: "NORMAL",
      pageType: "VIDEO_DETAIL",
      currentContentEvidence: {
        scopeKind: "CURRENT_MEDIA_ANCESTOR",
        hasStructuredTargetPayload: true,
        hasBoundPageMetadata: true,
        currentVideoCandidateCount: 1,
        videoCount: 1,
        hasContentEvidence: true,
      },
    });

    await page.locator("video").evaluate((node, contentId) => {
      node.parentElement?.setAttribute("data-aweme-id", contentId);
    }, CONTENT_B);
    expect(await identity(CONTENT_A, structured(CONTENT_A))).toMatchObject({
      state: "UNKNOWN",
      hasContentEvidence: false,
    });
  });

  it("Protected DOUYIN_DESKTOP_RUNTIME_PARITY：network payload 缺席时仅接受页面绑定身份与唯一正式播放器", async () => {
    await load(DESKTOP_CACHE_FIXTURE);
    expect(await identity()).toMatchObject({
      state: "NORMAL",
      pageType: "VIDEO_DETAIL",
      currentContentEvidence: {
        scopeKind: "DATA_E2E_VIDEO_DETAIL",
        hasStructuredTargetPayload: false,
        hasStructuredCurrentContent: true,
        hasBoundPageMetadata: true,
        currentVideoCandidateCount: 1,
        videoCount: 1,
        hasContentEvidence: true,
      },
    });

    await page.locator("[data-e2e='player-container']").evaluate((node) => {
      node.setAttribute("aria-hidden", "true");
    });
    expect(await identity()).toMatchObject({ state: "UNKNOWN", hasContentEvidence: false });

    await load(DESKTOP_CACHE_FIXTURE.replace(
      'data-e2e="video-detail"',
      `data-e2e="video-detail" data-aweme-id="${CONTENT_B}"`,
    ));
    expect(await identity()).toMatchObject({ state: "UNKNOWN", hasContentEvidence: false });
  });

  it("仅有 video URL 且没有当前内容证据时保持 UNKNOWN", async () => {
    await load("<html><head><title>抖音</title></head><body><main></main></body></html>");
    expect(await identity()).toMatchObject({ state: "UNKNOWN", hasContentEvidence: false });
  });

  it("任意推荐 video 即使有目标结构化 payload 也保持 UNKNOWN", async () => {
    await load(REAL_SHAPE_FIXTURE.replace(
      '<section class="current-video-shell">',
      '<section class="recommend-list">',
    ));
    expect(await identity(CONTENT_A, structured(CONTENT_A))).toMatchObject({
      state: "UNKNOWN",
      currentContentEvidence: { currentVideoCandidateCount: 0 },
    });
  });

  it("预加载 video 不能充当当前作品", async () => {
    await load(REAL_SHAPE_FIXTURE.replace(
      '<section class="current-video-shell">',
      '<section class="current-video-shell" data-preload="true">',
    ));
    expect(await identity(CONTENT_A, structured(CONTENT_A))).toMatchObject({ state: "UNKNOWN" });
  });

  it("隐藏的旧 SPA video 不能充当当前作品", async () => {
    await load(REAL_SHAPE_FIXTURE.replace(
      '<section class="current-video-shell">',
      '<section class="current-video-shell" aria-hidden="true">',
    ));
    expect(await identity(CONTENT_A, structured(CONTENT_A))).toMatchObject({ state: "UNKNOWN" });
  });

  it("URL A 与可见 DOM B 冲突时保持 UNKNOWN", async () => {
    await load(REAL_SHAPE_FIXTURE.replace(
      '<div class="xg-video-container">',
      `<div class="xg-video-container" data-aweme-id="${CONTENT_B}">`,
    ));
    expect(await identity(CONTENT_A, structured(CONTENT_A))).toMatchObject({ state: "UNKNOWN" });
  });

  it("URL A + structured A 完整 payload + 可见当前媒体在旧 selector 缺失时仍为 NORMAL", async () => {
    await load(REAL_SHAPE_FIXTURE);
    expect(await identity(CONTENT_A, structured(CONTENT_A))).toMatchObject({
      state: "NORMAL",
      pageType: "VIDEO_DETAIL",
    });
    expect(await page.locator(
      "[data-e2e='player-container'],[data-e2e='video-player'],[data-testid='douyin-video-player']",
    ).count()).toBe(0);
  });

  it("structured 只属于推荐作品 B 时不能确认 URL A", async () => {
    await load(REAL_SHAPE_FIXTURE);
    expect(await identity(CONTENT_A, structured(CONTENT_B))).toMatchObject({ state: "UNKNOWN" });
  });

  it("只有 A identity 而无内容 payload 时保持 UNKNOWN", async () => {
    await load(REAL_SHAPE_FIXTURE);
    expect(await identity(CONTENT_A, structured(CONTENT_A, false))).toMatchObject({ state: "UNKNOWN" });
  });

  it("当前 video 部分超出 viewport 仍为 NORMAL", async () => {
    await load(REAL_SHAPE_FIXTURE.replace(
      "<video data-current-player controls>",
      '<video data-current-player controls style="position:relative;top:-20px;height:100px;width:200px">',
    ));
    expect(await identity(CONTENT_A, structured(CONTENT_A))).toMatchObject({ state: "NORMAL" });
  });

  it("display:none 的当前 video 保持 UNKNOWN", async () => {
    await load(REAL_SHAPE_FIXTURE.replace(
      "<video data-current-player controls>",
      '<video data-current-player controls style="display:none">',
    ));
    expect(await identity(CONTENT_A, structured(CONTENT_A))).toMatchObject({ state: "UNKNOWN" });
  });

  it("NOTE_NOT_FOUND terminal marker 优先于看似完整的当前内容证据", async () => {
    await load(REAL_SHAPE_FIXTURE.replace("</body>", "<p>你要观看的视频不存在</p></body>"));
    expect(await identity(CONTENT_A, structured(CONTENT_A))).toMatchObject({ state: "NOTE_NOT_FOUND" });
  });

  it("无当前内容证据的 security marker 保持 SECURITY_RESTRICTED", async () => {
    await load("<html><head><title>安全验证</title></head><body>访问频繁，需要安全验证</body></html>");
    expect(await identity()).toMatchObject({ state: "SECURITY_RESTRICTED" });
  });

  it("登录按钮存在但公开当前内容证据完整时不判 LOGIN_REQUIRED", async () => {
    await load(REAL_SHAPE_FIXTURE.replace("</body>", "<button>扫码登录</button></body>"));
    expect(await identity(CONTENT_A, structured(CONTENT_A))).toMatchObject({
      state: "NORMAL",
      pageType: "VIDEO_DETAIL",
    });
  });

  it("URL A + DOM A + structured B 不使用 B，显式 DOM A 仍可独立确认", async () => {
    await load(`<!doctype html><html><head><title>作品 A</title></head><body>
      <main data-e2e="note-detail" data-aweme-id="${CONTENT_A}">
        <p data-e2e="video-desc">作品 A 正文</p><video></video>
      </main></body></html>`);
    const result = await identity(CONTENT_A, structured(CONTENT_B));
    expect(result).toMatchObject({
      state: "NORMAL",
      currentContentEvidence: {
        scopeContentId: CONTENT_A,
        hasStructuredTargetPayload: false,
      },
    });
  });
});
