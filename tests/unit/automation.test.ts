import { describe, expect, it } from "vitest";
import { createMockNote } from "../../lib/mock-data";
import {
  detectContentWarnings,
  failureCodeForPageStatus,
} from "../../lib/automation/classification";
import {
  classifyAutomaticPage,
  detectUnavailableXhsPage,
  detectXhsPageState,
  isShortXiaohongshuUrl,
  isXiaohongshuNoteDetailUrl,
  safePageLogUrl,
} from "../../lib/automation/page-classification";

describe("自动批量审核提取分类", () => {
  it("区分页面不存在、删除、无权限、登录失效和安全验证", () => {
    expect(failureCodeForPageStatus("NOTE_NOT_FOUND")).toBe("NOTE_NOT_FOUND");
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

describe("当前小红书页面分类", () => {
  it("将 website-login/error 安全限制页识别为安全验证", () => {
    expect(
      classifyAutomaticPage({
        url: "https://www.xiaohongshu.com/website-login/error?error_code=300012",
        title: "安全限制",
        visibleText: "IP存在风险，请切换可靠网络环境后重试",
      }),
    ).toBe("SECURITY_CHECK");
  });

  it.each([
    {
      title: "错误页 · 小红书 - 你访问的页面不见了",
      visibleText: "",
      expected: "NOTE_NOT_FOUND",
    },
    {
      title: "小红书",
      visibleText: "你访问的页面不见了",
      expected: "NOTE_NOT_FOUND",
    },
    {
      title: "小红书",
      visibleText: "当前笔记无法浏览",
      expected: "NOTE_NOT_FOUND",
    },
    {
      title: "小红书",
      visibleText: "该内容无法查看",
      expected: "NOTE_NOT_FOUND",
    },
    {
      title: "小红书",
      visibleText: "笔记已删除",
      expected: "NOTE_NOT_FOUND",
    },
  ])("识别错误页文案：$visibleText$title", ({ expected, ...input }) => {
    const evidence = detectUnavailableXhsPage({
      url: "https://www.xiaohongshu.com/explore/6a5cb375000000000301c549",
      ...input,
    });
    expect(evidence?.status).toBe(expected);
    expect(
      classifyAutomaticPage({
        url: "https://www.xiaohongshu.com/explore/6a5cb375000000000301c549",
        ...input,
      }),
    ).toBe("ERROR_PAGE");
  });

  it("通过最终错误页 URL 识别页面失效，但不把安全验证 URL 当成 404", () => {
    expect(
      detectUnavailableXhsPage({
        url: "https://www.xiaohongshu.com/not-found",
        title: "小红书",
        visibleText: "",
      })?.status,
    ).toBe("NOTE_NOT_FOUND");
    expect(
      detectUnavailableXhsPage({
        url: "https://www.xiaohongshu.com/website-login/error",
        title: "安全限制",
        visibleText: "IP存在风险",
      }),
    ).toBeNull();
  });

  it("使用明确 HTTP 404 或不存在 DOM 标记识别笔记不存在", () => {
    expect(
      detectUnavailableXhsPage({
        url: "https://www.xiaohongshu.com/explore/note",
        title: "小红书",
        visibleText: "",
        httpStatus: 404,
      })?.source,
    ).toBe("HTTP_STATUS");
    expect(
      detectUnavailableXhsPage({
        url: "https://www.xiaohongshu.com/explore/note",
        title: "小红书",
        visibleText: "",
        notFoundDomMarker: "你访问的页面不见了",
      })?.status,
    ).toBe("NOTE_NOT_FOUND");
  });

  it("标题先命中笔记不存在时仍保留最终 URL 错误码", () => {
    expect(
      detectUnavailableXhsPage({
        url: "https://www.xiaohongshu.com/404?noteId=note-1&errorCode=-510000",
        title: "小红书 - 你访问的页面不见了",
        visibleText: "你访问的页面不见了",
      }),
    ).toMatchObject({
      status: "NOTE_NOT_FOUND",
      source: "TITLE",
      errorCode: "-510000",
    });
  });

  it("正常空正文、登录、安全验证、超时分别保持独立状态", () => {
    expect(
      detectXhsPageState({
        url: "https://www.xiaohongshu.com/explore/6a5cb375000000000301c549",
        title: "正常笔记",
        visibleText: "",
      }),
    ).toBe("NORMAL");
    expect(
      detectXhsPageState({
        url: "https://www.xiaohongshu.com/login",
        title: "登录小红书",
        visibleText: "请先登录",
      }),
    ).toBe("NOT_LOGGED_IN");
    expect(
      detectXhsPageState({
        url: "https://www.xiaohongshu.com/website-login/captcha",
        title: "安全验证",
        visibleText: "请完成验证",
      }),
    ).toBe("SECURITY_RESTRICTED");
    expect(
      detectXhsPageState(
        { url: "https://www.xiaohongshu.com/explore/note", title: "", visibleText: "" },
        "PAGE_LOAD_TIMEOUT",
      ),
    ).toBe("PAGE_LOAD_TIMEOUT");
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
