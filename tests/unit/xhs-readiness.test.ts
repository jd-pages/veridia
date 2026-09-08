import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { collectDomPageSnapshot } from "@/lib/automation/xhs-page-evidence";
import { PlaywrightXiaohongshuAdapter } from "@/lib/automation/adapters";
import {
  readXhsReadinessPageEvidence,
  waitForXhsPageReadiness,
} from "@/lib/automation/xhs-readiness";

const noteUrl =
  "https://www.xiaohongshu.com/explore/6a798984000000000f039c00";
const publicLoggedOutNoteUrl =
  "https://www.xiaohongshu.com/explore/6a83a232000000002800120b";
const fixture = (name: string) => fs.readFileSync(
  path.resolve("tests", "regression", "fixtures", "xhs", name),
  "utf8",
);

describe("小红书页面 hydration 就绪门禁", () => {
  let browser: Browser | undefined;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, channel: "chrome" });
  }, 90_000);

  beforeEach(async () => {
    // Navigation fixtures leave a live document, pending media requests and
    // lifecycle state behind. Each case owns its page so a later setContent
    // cannot inherit the preceding fixture's load/navigation state.
    page = await browser!.newPage();
  });

  afterEach(async () => {
    await page?.close();
  });

  afterAll(async () => {
    await browser?.close();
  }, 30_000);

  it("站点壳层的全局 JSON-LD 和 generic main 不能独立成为 current-note", async () => {
    await page.setContent(`
      <script type="application/ld+json">
        {"title":"想了解些什么?","description":"想了解些什么?"}
      </script>
      <main><h1>想了解些什么?</h1><article>搜索推荐内容</article></main>
    `);

    await expect(
      waitForXhsPageReadiness({
        page,
        redirectChain: [],
        timeoutMs: 300,
        pollMs: 25,
      }),
    ).resolves.toBe(false);
    const snapshot = await collectDomPageSnapshot(page);
    expect(snapshot.currentNoteScopeSelector).toBeNull();
    expect(snapshot.keyElementCount).toBe(0);
    expect(snapshot.titleCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "想了解些什么?", source: "PAGE_JSON" }),
      ]),
    );
  });

  it("壳层与 JSON-LD 后跳转真实 404 时终态优先于普通提取", async () => {
    await page.route("https://www.xiaohongshu.com/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/404") {
        await route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: fixture("note-not-found.html"),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: fixture("generic-shell-delayed-404.html"),
      });
    });
    await page.goto(noteUrl, { waitUntil: "domcontentloaded" });
    const redirects: string[] = [];
    await expect(
      waitForXhsPageReadiness({
        page,
        redirectChain: redirects,
        timeoutMs: 2_500,
        pollMs: 25,
        httpStatus: 200,
      }),
    ).resolves.toBe(true);
    const evidence = await readXhsReadinessPageEvidence(page);
    expect(evidence.unavailablePage).toMatchObject({
      status: "NOTE_NOT_FOUND",
      errorCode: "-510001",
    });
    expect(evidence.finalUrl).toContain("/404?");
    expect(evidence.visibleText).toContain("你访问的页面不见了");
    await page.unrouteAll({ behavior: "wait" });
  });

  it("HTTP 200 且原作品 URL 未变时仍以不存在正文判定终态", async () => {
    await page.route(noteUrl, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><title>小红书</title><body><main>笔记不存在</main></body>`,
      });
    });
    const response = await page.goto(noteUrl, { waitUntil: "domcontentloaded" });
    await expect(
      readXhsReadinessPageEvidence(page, response?.status() ?? null),
    ).resolves.toMatchObject({
      finalUrl: noteUrl,
      unavailablePage: { status: "NOTE_NOT_FOUND", source: "BODY" },
    });
    await page.unrouteAll({ behavior: "wait" });
  });

  it("稳定 URL 但尚未 hydration 时继续等待 current-note 证据", async () => {
    await page.setContent(`
      <script>
        setTimeout(() => {
          document.body.innerHTML = '<main id="noteContainer"><h1 id="detail-title">延迟标题</h1><div id="detail-desc">延迟正文</div></main>';
        }, 350);
      </script>
    `);
    const redirects: string[] = [];
    await expect(
      waitForXhsPageReadiness({
        page,
        redirectChain: redirects,
        timeoutMs: 1_500,
        pollMs: 25,
      }),
    ).resolves.toBe(true);
    expect(await page.locator("#detail-title").textContent()).toBe("延迟标题");
  });

  it("Protected XHS_PUBLIC_LOGGED_OUT_NOTE_DETAIL：外围登录与 App CTA 不覆盖可读 current-note", async () => {
    await page.route(publicLoggedOutNoteUrl, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: fixture("public-logged-out-note-detail.html"),
      });
    });
    await page.goto(publicLoggedOutNoteUrl, { waitUntil: "domcontentloaded" });

    await expect(
      waitForXhsPageReadiness({
        page,
        redirectChain: [],
        timeoutMs: 1_500,
        pollMs: 25,
        httpStatus: 200,
      }),
    ).resolves.toBe(true);

    const readiness = await readXhsReadinessPageEvidence(page, 200);
    expect(readiness).toMatchObject({
      pageType: "NOTE_DETAIL",
      unavailablePage: null,
      currentNoteEvidence: {
        rootLocated: true,
        explicitIdentity: true,
        hasTitle: true,
        hasDescription: true,
        hasActionBar: true,
        hasMedia: true,
        corroboratingSignalCount: 4,
        isReadable: true,
        rootPath: "#noteContainer",
      },
    });

    const snapshot = await collectDomPageSnapshot(page);
    expect(snapshot.currentNoteScopeSelector).toBe(
      "[data-veridia-current-note-scope='true']",
    );
    expect(snapshot.pageStatus).toBe("NORMAL");
    expect(snapshot.titleCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        value: "混合喂养的神：德爱白金Pro",
        source: "DOM:#detail-title",
      }),
    ]));
    expect(snapshot.bodyCandidates[0]?.value.length).toBeGreaterThan(0);
    expect(snapshot.verifiedPlatformTopics.map((item) => item.displayText)).toEqual([
      "#爱他美德国白金版",
      "#爱他美新手爸妈日记",
    ]);
    expect(snapshot.publishedAtCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ raw: "7天前", location: "吉林" }),
    ]));

    const note = await new PlaywrightXiaohongshuAdapter().extract(
      page,
      publicLoggedOutNoteUrl,
    );
    expect(note).toMatchObject({
      pageStatus: "NORMAL",
      isPublic: true,
      title: "混合喂养的神：德爱白金Pro",
      imageCount: 3,
      publishedAtRaw: "7天前",
    });
    expect(note.body?.length).toBeGreaterThan(0);
    expect(note.topics.map((item) => item.displayText)).toEqual([
      "#爱他美德国白金版",
      "#爱他美新手爸妈日记",
    ]);
    await page.unrouteAll({ behavior: "wait" });
  });

  it("generic main 先出现时不提前提取，等待慢速 current-note 容器", async () => {
    await page.setContent(`
      <main><h1>想了解些什么?</h1></main>
      <script>
        setTimeout(() => {
          document.body.innerHTML += '<section id="noteContainer"><h1 id="detail-title">真正笔记标题</h1><div id="detail-desc">真正笔记正文</div></section>';
        }, 350);
      </script>
    `);
    const startedAt = Date.now();
    await expect(
      waitForXhsPageReadiness({
        page,
        redirectChain: [],
        timeoutMs: 1_500,
        pollMs: 25,
      }),
    ).resolves.toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300);
    expect(await page.locator("#detail-title").textContent()).toBe(
      "真正笔记标题",
    );
  });

  it("空白稳定页面不能被当作已就绪", async () => {
    await page.setContent("<div></div>");
    await expect(
      waitForXhsPageReadiness({
        page,
        redirectChain: [],
        timeoutMs: 300,
        pollMs: 25,
      }),
    ).resolves.toBe(false);
  });
});
