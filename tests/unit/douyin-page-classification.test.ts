import { describe, expect, it } from "vitest";
import { classifyDouyinPage, isDouyinContentDetailUrl, isDouyinShortUrl, safeDouyinDiagnosticUrl } from "@/lib/automation/douyin-page-classification";

describe("抖音页面分类", () => {
  it("仅接受作品详情与短链接", () => {
    expect(isDouyinContentDetailUrl("https://www.douyin.com/video/123")).toBe(true);
    expect(isDouyinContentDetailUrl("https://www.douyin.com/note/456")).toBe(true);
    expect(isDouyinShortUrl("https://v.douyin.com/abcdef/")).toBe(true);
    expect(isDouyinContentDetailUrl("https://www.douyin.com/user/123")).toBe(false);
  });

  it.each([
    ["作品不存在，该作品已删除", "NOTE_NOT_FOUND"],
    ["登录后继续，请扫码登录", "NOT_LOGGED_IN"],
    ["访问频繁，需要安全验证", "SECURITY_RESTRICTED"],
    ["私密作品，暂无权限查看", "NO_PERMISSION"],
  ] as const)("根据独立抖音证据分类 %s", (visibleText, expected) => {
    expect(classifyDouyinPage({ url: "https://www.douyin.com/video/123", visibleText }).state).toBe(expected);
  });

  it("区分超时、网络异常和正常空内容", () => {
    expect(classifyDouyinPage({ url: "https://www.douyin.com/video/123", timedOut: true }).state).toBe("PAGE_LOAD_TIMEOUT");
    expect(classifyDouyinPage({ url: "https://www.douyin.com/video/123", networkError: true }).state).toBe("NETWORK_ERROR");
    expect(classifyDouyinPage({ url: "https://www.douyin.com/video/123", visibleText: "" }).state).toBe("NORMAL");
  });

  it("区分 App 唤起页和普通作品详情", () => {
    expect(
      classifyDouyinPage({
        url: "https://www.douyin.com/download",
        visibleText: "打开抖音 App 查看",
      }).state,
    ).toBe("APP_LAUNCH");
    expect(
      classifyDouyinPage({
        url: "https://www.douyin.com/video/123",
        visibleText: "作品正文",
      }).state,
    ).toBe("NORMAL");
  });

  it("诊断日志移除查询参数", () => {
    expect(safeDouyinDiagnosticUrl("https://www.douyin.com/video/123?token=secret#x")).toBe("https://www.douyin.com/video/123");
  });

  it("识别抖音图文不存在的真实页面文案", () => {
    expect(classifyDouyinPage({
      url: "https://www.douyin.com/note/7655908365168783077",
      visibleText: "你要观看的图文不存在",
    })).toMatchObject({
      state: "NOTE_NOT_FOUND",
      matchedCondition: "not-found-marker",
    });
  });

  it("作品类型只由真实详情路径决定，不受分享文案影响", () => {
    expect(classifyDouyinPage({
      url: "https://www.douyin.com/video/123",
      visibleText: "图文作品",
    }).pageType).toBe("VIDEO_DETAIL");
    expect(classifyDouyinPage({
      url: "https://www.douyin.com/note/456",
      visibleText: "页面中包含 video 元素",
    }).pageType).toBe("IMAGE_TEXT_DETAIL");
  });
});
