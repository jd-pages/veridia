import { describe, expect, it } from "vitest";
import { createMockNote } from "../../lib/mock-data";
import {
  detectContentWarnings,
  failureCodeForPageStatus,
} from "../../lib/automation/classification";
import {
  classifyAutomaticPage,
  isShortXiaohongshuUrl,
  isXiaohongshuNoteDetailUrl,
  safePageLogUrl,
} from "../../lib/automation/page-classification";

describe("自动批量审核提取分类", () => {
  it("区分页面不存在、删除、无权限、登录失效和安全验证", () => {
    expect(failureCodeForPageStatus("NOT_FOUND")).toBe("PAGE_NOT_FOUND");
    expect(failureCodeForPageStatus("DELETED")).toBe("NOTE_DELETED");
    expect(failureCodeForPageStatus("NO_PERMISSION")).toBe("NO_PERMISSION");
    expect(failureCodeForPageStatus("LOGIN_EXPIRED")).toBe("LOGIN_REQUIRED");
    expect(failureCodeForPageStatus("SECURITY_VERIFICATION")).toBe(
      "SECURITY_CHECK",
    );
  });

  it("分别识别正文和话题缺失，忽略图片缺失", () => {
    expect(detectContentWarnings(createMockNote("empty-body"))).toContain(
      "BODY_NOT_RECOGNIZED",
    );
    expect(detectContentWarnings(createMockNote("no-images"))).toEqual([]);
    expect(detectContentWarnings(createMockNote("no-topics"))).toContain(
      "TOPICS_NOT_RECOGNIZED",
    );
  });

  it("正常模拟笔记没有提取警告", () => {
    expect(detectContentWarnings(createMockNote("passed"))).toEqual([]);
  });
});

describe("小红书页面与短链接分类", () => {
  it("识别 xhslink.com、xhslink.cn 短链接和真实笔记详情链接", () => {
    expect(isShortXiaohongshuUrl("http://xhslink.com/o/6c1AI7QAhyf")).toBe(
      true,
    );
    expect(isShortXiaohongshuUrl("http://xhslink.cn/o/1JLlTKa04Vv")).toBe(
      true,
    );
    expect(
      isXiaohongshuNoteDetailUrl(
        "https://www.xiaohongshu.com/explore/6a5cb375000000000301c549",
      ),
    ).toBe(true);
    expect(
      isXiaohongshuNoteDetailUrl(
        "https://www.xiaohongshu.com/discovery/item/6a5cb375000000000301c549",
      ),
    ).toBe(true);
  });

  it("页面日志会遮蔽分享查询令牌", () => {
    const logged = safePageLogUrl(
      "https://www.xiaohongshu.com/explore/note?xsec_token=secret&shareRedId=red&share_id=share",
    );
    expect(logged).not.toContain("secret");
    expect(logged).not.toContain("shareRedId=red");
    expect(logged).not.toContain("share_id=share");
    expect(logged).toContain("%5Bredacted%5D");
  });

  it.each([
    {
      expected: "NOTE_DETAIL",
      url: "https://www.xiaohongshu.com/explore/6a5cb375000000000301c549",
      title: "小宝奶粉分享～ - 小红书",
      visibleText: "正文内容",
    },
    {
      expected: "LOGIN",
      url: "https://www.xiaohongshu.com/login",
      title: "登录小红书",
      visibleText: "请登录后继续",
    },
    {
      expected: "SECURITY_CHECK",
      url: "https://www.xiaohongshu.com/website-login/captcha",
      title: "安全验证",
      visibleText: "请完成滑块验证",
    },
    {
      expected: "APP_LAUNCH",
      url: "https://www.xiaohongshu.com/mobile",
      title: "打开小红书 App",
      visibleText: "立即打开 App",
    },
    {
      expected: "ERROR_PAGE",
      url: "https://www.xiaohongshu.com/404",
      title: "页面不存在",
      visibleText: "内容已删除",
    },
  ])("识别 $expected 页面", ({ expected, ...page }) => {
    expect(classifyAutomaticPage(page)).toBe(expected);
  });
});
