import { describe, expect, it } from "vitest";
import {
  classifyNoteUrl,
  extractNoteLinksFromText,
  resolveImportedNoteLink,
} from "@/lib/note-links";
import { normalizeUrl } from "@/lib/topic";

const discoveryUrl =
  "https://www.xiaohongshu.com/discovery/item/6a4867200000000011007d92?source=webshare&xhsshare=pc_web&xsec_token=CBx0JoKq5oj169Vy8ZiPhRdn-bvJf8F3BxQVS-qYT7i50=&xsec_source=pc_share";
const exploreUrl =
  "https://www.xiaohongshu.com/explore/6a461e7600000000160272d2?app_platform=android&ignoreEngage=true&app_version=9.36.0&share_from_user_hidden=true&xsec_source=app_share&type=normal&xsec_token=CBIDfFrnZoMyO5ZoxVngbuPZ0I4QORwcxEFLAjTGOvKTM=&author_share=1&source=noteDetail_Screenshot&shareRedId=ODdGOTc8R002NzUyOTgwNjczOTdKPTY6&apptime=1782980236&share_id=cae8346cb00c4610bd35f6f760ffefd3&share_channel=copy_link&appuid=61d947cd000000001000f801&xhsshare=CopyLink";

describe("统一小红书链接提取", () => {
  it("从 App 分享文案提取 xhslink.com 并忽略说明文字", () => {
    const result = extractNoteLinksFromText(
      "澳爱白金 我家宝宝喝澳白这段时间... http://xhslink.com/o/5ozOTAxN3lf\n把这段复制好，然后去【小红书】就能看笔记。",
    );
    expect(result.links).toEqual([
      {
        url: "http://xhslink.com/o/5ozOTAxN3lf",
        platform: "XIAOHONGSHU",
        type: "SHORT",
      },
    ]);
    expect(result.unrecognized).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "未识别到链接" }),
      ]),
    );
  });

  it("从 PC 分享文案提取 discovery/item 且不截断令牌", () => {
    const result = extractNoteLinksFromText(
      `42 【分享宝宝的奶粉心得 | 小红书】 😆 Z4iB34iUydio9pH 😆 ${discoveryUrl}`,
    );
    expect(result.links.map((item) => item.url)).toEqual([discoveryUrl]);
    expect(result.rawInput).toContain("Z4iB34iUydio9pH");
  });

  it("完整保留 explore 的全部 App 参数和末尾参数", () => {
    const [link] = extractNoteLinksFromText(`${exploreUrl}。`).links;
    expect(link.url).toBe(exploreUrl);
    expect(link.url).toContain("xsec_token=CBIDfFrnZoMyO5ZoxVngbuPZ0I4QORwcxEFLAjTGOvKTM=&author_share=1");
    expect(link.url).toContain("shareRedId=");
    expect(link.url).toContain("share_id=");
    expect(link.url).toContain("appuid=");
    expect(link.url).toContain("&xhsshare=CopyLink");
  });

  it("支持 xhslink.cn、http/https、混合多链接并自动去重", () => {
    const result = extractNoteLinksFromText([
      "http://xhslink.cn/o/1JLlTKa04Vv",
      `说明 ${discoveryUrl}`,
      discoveryUrl,
      "https://xhslink.com/o/abc",
    ]);
    expect(result.recognizedCount).toBe(4);
    expect(result.duplicateCount).toBe(1);
    expect(result.links.map((item) => item.url)).toEqual([
      "http://xhslink.cn/o/1JLlTKa04Vv",
      discoveryUrl,
      "https://xhslink.com/o/abc",
    ]);
    expect(classifyNoteUrl("http://xhslink.cn/o/1JLlTKa04Vv")).toMatchObject({
      platform: "XIAOHONGSHU",
      type: "SHORT",
      supported: true,
    });
  });

  it("同时识别抖音与小红书链接并保留平台身份", () => {
    const result = extractNoteLinksFromText(
      `无效说明\nhttps://www.douyin.com/video/123\n${discoveryUrl}`,
    );
    expect(result.links).toHaveLength(2);
    expect(result.links[0]).toMatchObject({ platform: "DOUYIN", type: "LONG" });
    expect(result.unrecognized).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "未识别到链接" }),
      ]),
    );
  });

  it("抖音长链接规范化时移除跟踪参数但保留作品身份", () => {
    expect(
      normalizeUrl(
        "https://www.douyin.com/video/123?share_token=secret&utm_source=copy",
      ),
    ).toBe("https://www.douyin.com/video/123");
  });
});

describe("表格链接列解析", () => {
  it("优先使用 hyperlink.target 中的小红书链接", () => {
    const result = resolveImportedNoteLink({
      rawContent: "打开笔记 https://www.example.com/article/1",
      hyperlinkTarget: "http://xhslink.cn/o/hyperlink",
      declaredChannel: "小红书",
    });
    expect(result.status).toBe("RECOGNIZED");
    expect(result.url).toBe("http://xhslink.cn/o/hyperlink");
    expect(result.originalContent).toContain("打开笔记");
  });

  it("单元格多个链接时按声明渠道提取对应平台", () => {
    const xhs = resolveImportedNoteLink({
      rawContent: `https://example.com/a ${discoveryUrl}`,
    });
    expect(xhs.url).toBe(discoveryUrl);
    const douyin = resolveImportedNoteLink({
      rawContent: "https://www.douyin.com/video/123",
      declaredChannel: "抖音",
    });
    expect(douyin).toMatchObject({
      status: "RECOGNIZED",
      url: "https://www.douyin.com/video/123",
      platform: "DOUYIN",
    });
  });

  it("拒绝抖音用户页、搜索页、直播页和渠道错配", () => {
    for (const url of [
      "https://www.douyin.com/user/abc",
      "https://www.douyin.com/search/奶粉",
      "https://live.douyin.com/123",
    ]) {
      expect(classifyNoteUrl(url)).toMatchObject({ platform: "DOUYIN", supported: false });
    }
    expect(resolveImportedNoteLink({ rawContent: discoveryUrl, declaredChannel: "抖音" })).toMatchObject({
      status: "UNRECOGNIZED",
      failureReason: expect.stringContaining("内容渠道与链接平台不一致"),
    });
  });

  it("空链接行和未知平台行分别给出失败原因", () => {
    expect(resolveImportedNoteLink({ rawContent: "" })).toMatchObject({
      status: "UNRECOGNIZED",
      failureReason: "链接（必填）列为空",
    });
    expect(
      resolveImportedNoteLink({ rawContent: "https://example.com/a" }),
    ).toMatchObject({
      status: "UNRECOGNIZED",
      failureReason: "未识别的平台链接",
    });
  });
});
