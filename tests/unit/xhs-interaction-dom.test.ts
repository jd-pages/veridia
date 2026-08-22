import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { collectXhsInteractionMetrics } from "@/lib/interaction-metrics";

function actionControl(
  className: string,
  iconClass: string,
  iconHref: string,
  value: string,
) {
  return `
    <span class="${className}">
      <svg class="reds-icon ${iconClass}" width="24" height="24"><use href="${iconHref}"></use></svg>
      <span class="count">${value}</span>
    </span>
  `;
}

function currentNoteFixture({
  like = "7361",
  favorite = "1243",
  comment = "3052",
  commentSummary = "3052",
  includeFavorite = true,
}: {
  like?: string;
  favorite?: string;
  comment?: string;
  commentSummary?: string | null;
  includeFavorite?: boolean;
} = {}) {
  return `
    <div id="noteContainer" class="note-container">
      <div class="interaction-container">
        <div class="note-scroller">
          <div id="detail-desc">当前作品正文</div>
          <div class="comments-container">
            ${commentSummary === null ? "" : `<div class="total">共 ${commentSummary} 条评论</div>`}
            <div class="list-container">
              <div class="parent-comment">
                <div class="interactions">
                  <span class="like-wrapper like-active">
                    <svg class="reds-icon like-icon" width="16" height="16"><use href="#like"></use></svg>
                    <span class="count">10+</span>
                  </span>
                  <span>回复 1</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="interactions engage-bar">
          <div class="engage-bar-container">
            <div class="engage-bar">
              <div class="input-box">
                <div class="interact-container">
                  <div class="buttons engage-bar-style">
                    <div class="left">
                      ${actionControl("like-wrapper like-active", "like-icon", "#like", like)}
                      ${includeFavorite ? actionControl("collect-wrapper", "collect-icon", "/web-static/svg-sprite.6.45.1.svg#collect", favorite) : ""}
                      ${actionControl("chat-wrapper", "", "/web-static/svg-sprite.6.45.1.svg#chat", comment)}
                    </div>
                    <div class="share-wrapper"><svg width="24" height="24"><use href="#share"></use></svg></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <aside class="recommend-list">
      <span class="like-wrapper like-active"><span class="count">9999</span></span>
      <span class="collect-wrapper"><span class="count">8888</span></span>
      <span class="chat-wrapper"><span class="count">7777</span></span>
    </aside>
  `;
}

describe("小红书 current note action bar 互动取证", () => {
  let browser: Browser | undefined;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, channel: "chrome" });
    page = await browser.newPage();
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
  }, 30_000);

  it("按真实 class 与 SVG 签名读取 7361/1243/3052 并排除评论、推荐互动", async () => {
    await page.setContent(currentNoteFixture());
    const result = await collectXhsInteractionMetrics(page);

    expect(result).toMatchObject({
      likeCount: 7_361,
      favoriteCount: 1_243,
      commentCount: 3_052,
      totalCount: 11_656,
      status: "SUCCESS",
      conflictCode: null,
    });
    expect(result.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kindHint: "LIKE",
          controlClass: "like-wrapper like-active",
          iconHref: "#like",
          slot: 0,
          source: "DOM_CURRENT_NOTE_ACTION_BAR:SEMANTIC_CLASS",
        }),
        expect.objectContaining({
          kindHint: "FAVORITE",
          controlClass: "collect-wrapper",
          iconHref: "/web-static/svg-sprite.6.45.1.svg#collect",
          slot: 1,
        }),
        expect.objectContaining({
          kindHint: "COMMENT",
          controlClass: "chat-wrapper",
          iconHref: "/web-static/svg-sprite.6.45.1.svg#chat",
          slot: 2,
        }),
        expect.objectContaining({
          kindHint: "COMMENT",
          valueText: "共 3052 条评论",
          source: "DOM_COMMENT_SUMMARY",
        }),
      ]),
    );
    expect(JSON.stringify(result.candidates)).not.toContain("9999");
    expect(JSON.stringify(result.candidates)).not.toContain("8888");
    expect(JSON.stringify(result.candidates)).not.toContain("7777");
    expect(JSON.stringify(result.candidates)).not.toContain("10+");
  });

  it("小数字 22 与独立收藏、评论值正常计算", async () => {
    await page.setContent(
      currentNoteFixture({ like: "22", favorite: "3", comment: "4", commentSummary: "4" }),
    );
    expect(await collectXhsInteractionMetrics(page)).toMatchObject({
      likeCount: 22,
      favoriteCount: 3,
      commentCount: 4,
      totalCount: 29,
      status: "SUCCESS",
    });
  });

  it("缺少收藏证据时不估算且图标无数字不当作 0", async () => {
    await page.setContent(
      currentNoteFixture({
        like: "",
        comment: "",
        commentSummary: null,
        includeFavorite: false,
      }),
    );
    expect(await collectXhsInteractionMetrics(page)).toMatchObject({
      likeCount: null,
      favoriteCount: null,
      commentCount: null,
      totalCount: null,
      status: "UNAVAILABLE",
    });
  });

  it("仅在已验证 action bar 恰有三个槽位时使用固定 slot fallback", async () => {
    await page.setContent(`
      <div id="noteContainer">
        <div class="interaction-container">
          <div class="interactions engage-bar">
            <div class="buttons engage-bar-style"><div class="left">
              <span class="metric-control"><span class="count">1</span></span>
              <span class="metric-control"><span class="count">2</span></span>
              <span class="metric-control"><span class="count">3</span></span>
            </div></div>
          </div>
        </div>
      </div>
    `);
    const result = await collectXhsInteractionMetrics(page);
    expect(result).toMatchObject({
      likeCount: 1,
      favoriteCount: 2,
      commentCount: 3,
      totalCount: 6,
      status: "SUCCESS",
    });
    expect(result.candidates.every((item) => item.source?.endsWith("VERIFIED_SLOT"))).toBe(true);
  });

  it("action bar 评论数与评论汇总冲突时标记冲突并停止合计", async () => {
    await page.setContent(currentNoteFixture({ commentSummary: "3051" }));
    expect(await collectXhsInteractionMetrics(page)).toMatchObject({
      likeCount: 7_361,
      favoriteCount: 1_243,
      commentCount: 3_052,
      totalCount: null,
      status: "UNAVAILABLE",
      conflictCode: "INTERACTION_COUNT_CONFLICT",
    });
  });
});
