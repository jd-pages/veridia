import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { PlaywrightXiaohongshuAdapter } from "@/lib/automation/adapters";

const noteUrl = "https://www.xiaohongshu.com/explore/6a7d71e60000000035014e8f";

function fixture({
  metadataTime,
  commentTime,
  recommendedTime,
  wrapMetadata = false,
}: {
  metadataTime?: string;
  commentTime?: string;
  recommendedTime?: string;
  wrapMetadata?: boolean;
}) {
  const timeNode = metadataTime
    ? `<span class="platform-clock">${metadataTime}</span>`
    : "";
  return `
    <main id="noteContainer" class="note-container">
      <div class="note-scroller">
        <div id="detail-desc">当前作品正文与话题</div>
        ${
          wrapMetadata
            ? `<div class="metadata-row">正文 + 话题 + ${timeNode}</div>`
            : `<div class="metadata-row">${timeNode}</div>`
        }
        <section class="comments-container">
          ${commentTime ? `<span>${commentTime}</span>` : ""}
        </section>
        <aside class="recommend-list">
          ${recommendedTime ? `<span>${recommendedTime}</span>` : ""}
        </aside>
      </div>
    </main>
  `;
}

describe("小红书 current note 普通 metadata 平台时间取证", () => {
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

  it("从无时间 class 的叶子 span 识别编辑于 昨天 18:17 并剥离属地", async () => {
    await page.setContent(
      fixture({
        metadataTime: "编辑于 昨天 18:17 河南",
        commentTime: "昨天 18:17",
        recommendedTime: "07-29",
      }),
    );
    const note = await adapter.extract(page, noteUrl);
    expect(note).toMatchObject({
      publishedAt: null,
      publishedAtRaw: "编辑于 昨天 18:17",
      publishedAtSource: expect.stringContaining(
        "DOM_MAIN_NOTE_METADATA_FALLBACK:span.platform-clock",
      ),
    });
    expect(note.pageEvidence?.publishedAtCandidate).toMatchObject({
      raw: "编辑于 昨天 18:17",
      timeToken: "昨天 18:17",
      location: "河南",
      timeKind: "EDITED",
    });
  });

  it.each([
    ["编辑于 4小时前 河南", "编辑于 4小时前", "4小时前", "河南", "EDITED"],
    ["编辑于 3天前 上海", "编辑于 3天前", "3天前", "上海", "EDITED"],
    ["编辑于 07-29 浙江", "编辑于 07-29", "07-29", "浙江", "EDITED"],
    ["发布于 07-29 上海", "发布于 07-29", "07-29", "上海", "PUBLISHED"],
    ["07-29 安徽", "07-29", "07-29", "安徽", "DISPLAYED"],
  ] as const)(
    "普通 current-note metadata 节点识别 %s",
    async (metadataTime, raw, timeToken, location, timeKind) => {
      await page.setContent(fixture({ metadataTime }));
      const note = await adapter.extract(page, noteUrl);
      expect(note.pageEvidence?.publishedAtCandidate).toMatchObject({
        raw,
        timeToken,
        location,
        timeKind,
        source: expect.stringContaining("DOM_MAIN_NOTE_METADATA_FALLBACK"),
      });
    },
  );

  it("评论和推荐区域时间不能作为当前作品平台时间", async () => {
    await page.setContent(
      fixture({
        commentTime: "昨天 18:17",
        recommendedTime: "07-29",
      }),
    );
    const note = await adapter.extract(page, noteUrl);
    expect(note.publishedAtRaw).toBeNull();
    expect(note.pageEvidence?.publishedAtCandidate).toBeNull();
  });

  it("父容器整段文字不入证据，只采用最小时间叶子节点", async () => {
    await page.setContent(
      fixture({ metadataTime: "编辑于 昨天 18:17 河南", wrapMetadata: true }),
    );
    const note = await adapter.extract(page, noteUrl);
    expect(note.publishedAtRaw).toBe("编辑于 昨天 18:17");
    expect(note.publishedAtSource).toContain("span.platform-clock");
    expect(note.publishedAtSource).not.toContain("div.metadata-row");
  });
});
