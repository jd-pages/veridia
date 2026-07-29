import { describe, expect, it } from "vitest";
import { compareTopic, isSupportedNoteUrl, normalizeTopic } from "@/lib/topic";

describe("topic helpers", () => {
  it("规范化井号和首尾空格", () => {
    expect(normalizeTopic("  ##inne多维锌  ")).toBe("#inne多维锌");
  });

  it("精确匹配不接受多字少字或错字", () => {
    expect(compareTopic("#inne多维锌", "#inne多维锌")).toBe(true);
    expect(compareTopic("#inne锌", "#inne多维锌")).toBe(false);
    expect(compareTopic("#inne多维辛", "#inne多维锌")).toBe(false);
    expect(compareTopic("#inne多维锌推荐", "#inne多维锌")).toBe(false);
  });

  it("只接受小红书和本地模拟链接", () => {
    expect(isSupportedNoteUrl("https://www.xiaohongshu.com/explore/123")).toBe(true);
    expect(isSupportedNoteUrl("http://localhost:3000/mock/xhs")).toBe(true);
    expect(isSupportedNoteUrl("https://example.com/note")).toBe(false);
  });
});
