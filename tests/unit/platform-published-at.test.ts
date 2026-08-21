import { describe, expect, it } from "vitest";
import {
  formatPlatformPublishedAt,
  formatShanghaiDateTime,
  parseStructuredPublishedAt,
  parseXhsPublishedAtText,
} from "@/lib/platform-published-at";

describe("平台真实发帖时间", () => {
  it.each([
    ["07-27 浙江", "07-27", null],
    ["07-27 19:05 浙江", "07-27 19:05", null],
    ["昨天 19:05 福建", "昨天 19:05", null],
    ["6天前 福建", "6天前", null],
    ["3小时前 福建", "3小时前", null],
    ["25分钟前 福建", "25分钟前", null],
    ["2025-12-30 浙江", "2025-12-30", expect.any(String)],
    ["2026-07-27 19:05 浙江", "2026-07-27 19:05", expect.any(String)],
  ] as const)("保留小红书平台原始时间 %s 并去除属地", (input, raw, value) => {
    const result = parseXhsPublishedAtText(
      input,
      "DOM_MAIN_NOTE:test",
      "6a5cb375000000000301c549",
    );
    expect(result).toMatchObject({
      raw,
      value,
      source: "DOM_MAIN_NOTE:test",
      contentId: "6a5cb375000000000301c549",
    });
    expect(formatPlatformPublishedAt(result?.value, result?.raw)).toBe(raw);
  });

  it.each([
    ["编辑于 4小时前 河南", "编辑于 4小时前", "4小时前", "河南", "EDITED"],
    ["编辑于 3天前 上海", "编辑于 3天前", "3天前", "上海", "EDITED"],
    ["编辑于 昨天 12:30 北京", "编辑于 昨天 12:30", "昨天 12:30", "北京", "EDITED"],
    ["编辑于 07-29 浙江", "编辑于 07-29", "07-29", "浙江", "EDITED"],
    ["发布于 4小时前 河南", "发布于 4小时前", "4小时前", "河南", "PUBLISHED"],
    ["发布于 07-29 上海", "发布于 07-29", "07-29", "上海", "PUBLISHED"],
  ] as const)(
    "识别平台时间前缀并从证据中剥离 IP 属地 %s",
    (input, raw, timeToken, location, timeKind) => {
      expect(
        parseXhsPublishedAtText(input, "DOM_MAIN_NOTE:test", "note-id"),
      ).toMatchObject({
        raw,
        timeToken,
        location,
        timeKind,
        value: null,
      });
    },
  );

  it("编辑时间即使带完整日期也不伪装成首次发布时间", () => {
    expect(
      parseXhsPublishedAtText(
        "编辑于 2026-08-21 14:30 河南",
        "DOM_MAIN_NOTE:test",
        "note-id",
      ),
    ).toMatchObject({
      raw: "编辑于 2026-08-21 14:30",
      timeToken: "2026-08-21 14:30",
      timeKind: "EDITED",
      value: null,
    });
  });

  it("不为无年份日期补年份，也不转换相对时间", () => {
    const monthDay = parseXhsPublishedAtText(
      "12-30 浙江",
      "DOM_MAIN_NOTE:test",
      "6a5cb375000000000301c549",
    );
    const relative = parseXhsPublishedAtText(
      "6天前 福建",
      "DOM_MAIN_NOTE:test",
      "6a5cb375000000000301c549",
    );
    expect(monthDay).toMatchObject({ raw: "12-30", value: null });
    expect(relative).toMatchObject({ raw: "6天前", value: null });
  });

  it("只接受时间前缀，不把普通正文当成时间", () => {
    expect(
      parseXhsPublishedAtText(
        "这段正文提到了昨天 19:44 福建",
        "DOM_MAIN_NOTE:test",
        "6a5cb375000000000301c549",
      ),
    ).toBeNull();
  });

  it("结构化 Unix 时间转换为上海时间显示且保留当前 contentId", () => {
    const result = parseStructuredPublishedAt(
      1_786_071_651,
      "DOUYIN_STRUCTURED:create_time",
      "7658919904867844532",
    );
    expect(result).toMatchObject({
      raw: expect.stringMatching(/^2026-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u),
      value: expect.any(String),
      source: "DOUYIN_STRUCTURED:create_time",
      contentId: "7658919904867844532",
    });
    expect(formatShanghaiDateTime(result?.value)).toBe(result?.raw);
  });

  it("Douyin DOM 时间保持页面秒级文本且不重复转换时区", () => {
    const result = parseStructuredPublishedAt(
      "发布时间：2026-08-04 14:40:13",
      "DOUYIN_DOM_CURRENT_DETAIL",
      "7658919904867844532",
    );
    expect(result?.raw).toBe("2026-08-04 14:40:13");
    expect(formatShanghaiDateTime(result?.value)).toBe("2026-08-04 14:40:13");
  });

  it("无可靠时间时保持为空", () => {
    expect(parseStructuredPublishedAt(null, "TEST", "1")).toBeNull();
    expect(
      parseXhsPublishedAtText(
        "福建",
        "DOM_MAIN_NOTE:test",
        "6a5cb375000000000301c549",
      ),
    ).toBeNull();
    expect(formatPlatformPublishedAt(null, null)).toBe("未识别到平台时间");
  });
});
