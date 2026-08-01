import { describe, expect, it } from "vitest";
import { parseStoredStringArray } from "@/lib/stored-json";

describe("历史 JSON 字段兼容", () => {
  it("合法字符串数组正常读取", () => {
    expect(parseStoredStringArray('["话题缺失","图片不足"]')).toEqual([
      "话题缺失",
      "图片不足",
    ]);
  });

  it("空值、损坏 JSON 和非数组不会让仪表盘接口崩溃", () => {
    expect(parseStoredStringArray(null)).toEqual([]);
    expect(parseStoredStringArray("{broken")).toEqual([]);
    expect(parseStoredStringArray('{"reason":"x"}')).toEqual([]);
  });
});
