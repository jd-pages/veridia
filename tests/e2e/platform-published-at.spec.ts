import { expect, test, type Page } from "@playwright/test";
import { PlaywrightXiaohongshuAdapter } from "@/lib/automation/adapters";
import { PlaywrightDouyinAdapter } from "@/lib/automation/douyin-adapter";

const xhsNoteId = "6a5cb375000000000301c549";
const douyinContentId = "7658919904867844532";

async function extractXhsFixture(
  page: Page,
  publishedText: string,
  options: {
    commentTime?: string;
    recommendedTime?: string;
    bodyTime?: string;
  } = {},
) {
  const params = new URLSearchParams({ case: "passed", publishedText });
  if (options.commentTime) params.set("commentTime", options.commentTime);
  if (options.recommendedTime) {
    params.set("recommendedTime", options.recommendedTime);
  }
  if (options.bodyTime) params.set("bodyTime", options.bodyTime);
  await page.goto(`/mock/xhs?${params.toString()}`);
  return new PlaywrightXiaohongshuAdapter().extract(
    page,
    `https://www.xiaohongshu.com/explore/${xhsNoteId}`,
  );
}

async function extractDouyinFixture(
  page: Page,
  publishedText: string,
  recommendedTime?: string,
) {
  const params = new URLSearchParams({
    case: "video",
    raw: "true",
    publishedText,
  });
  if (recommendedTime) params.set("recommendedTime", recommendedTime);
  await page.goto(`/mock/douyin?${params.toString()}`);
  return new PlaywrightDouyinAdapter().extract(
    page,
    `https://www.douyin.com/video/${douyinContentId}`,
    { contentId: douyinContentId },
  );
}

test("小红书保留 MM-DD 原文、忽略 IP 属地且不补年份", async ({ page }) => {
  const note = await extractXhsFixture(page, "07-27 浙江");
  expect(note).toMatchObject({
    noteId: xhsNoteId,
    publishedAt: null,
    publishedAtRaw: "07-27",
  });
  expect(note.publishedAtSource).toContain("DOM_MAIN_NOTE");
});

test("小红书保留相对时间原文并排除评论时间", async ({ page }) => {
  const yesterday = await extractXhsFixture(
    page,
    "昨天 19:05 福建",
    { commentTime: "昨天 19:44 福建" },
  );
  expect(yesterday.publishedAtRaw).toBe("昨天 19:05");
  expect(yesterday.publishedAt).toBeNull();
  expect(JSON.stringify(yesterday.pageEvidence?.publishedAtCandidate)).not.toContain(
    "19:44",
  );

  const daysAgo = await extractXhsFixture(page, "6天前 福建", {
    commentTime: "6天前 安徽",
  });
  expect(daysAgo.publishedAtRaw).toBe("6天前");
  expect(daysAgo.publishedAt).toBeNull();
});

test("小红书仅从当前作品 metadata 识别带前缀的平台时间", async ({ page }) => {
  const note = await extractXhsFixture(page, "编辑于 4小时前 河南", {
    commentTime: "发布于 3小时前 上海",
    recommendedTime: "发布于 2小时前 北京",
    bodyTime: "发布于 1小时前 浙江",
  });
  expect(note).toMatchObject({
    noteId: xhsNoteId,
    publishedAt: null,
    publishedAtRaw: "编辑于 4小时前",
  });
  expect(note.pageEvidence?.publishedAtCandidate).toMatchObject({
    raw: "编辑于 4小时前",
    timeToken: "4小时前",
    location: "河南",
    timeKind: "EDITED",
    source: expect.stringContaining("DOM_MAIN_NOTE"),
  });
  const evidence = JSON.stringify(note.pageEvidence?.publishedAtCandidate);
  expect(evidence).not.toContain("3小时前");
  expect(evidence).not.toContain("2小时前");
  expect(evidence).not.toContain("1小时前");
});

test("小红书保留平台明确显示的完整年份", async ({ page }) => {
  const note = await extractXhsFixture(page, "2025-12-30 浙江");
  expect(note.publishedAtRaw).toBe("2025-12-30");
  expect(note.publishedAt).not.toBeNull();
});

for (const publishedText of [
  "2026-07-29 21:49:48",
  "2026-07-30 15:36:29",
  "2026-08-04 14:40:13",
] as const) {
  test(`抖音当前作品保留秒级发布时间 ${publishedText}`, async ({ page }) => {
    const note = await extractDouyinFixture(
      page,
      publishedText,
      "2024-01-01 00:00:00",
    );
    expect(note).toMatchObject({
      noteId: douyinContentId,
      publishedAtRaw: publishedText,
      publishedAtSource: expect.stringContaining("DOUYIN_DOM_CURRENT_DETAIL"),
    });
    expect(JSON.stringify(note.pageEvidence?.publishedAtCandidate)).not.toContain(
      "2024-01-01",
    );
  });
}
