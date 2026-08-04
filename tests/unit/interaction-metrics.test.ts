import { describe, expect, it } from "vitest";
import {
  parseInteractionCount,
  resolveInteractionMetrics,
} from "@/lib/interaction-metrics";

describe("小红书互动数解析", () => {
  it.each([
    ["4", 4],
    ["176", 176],
    ["1万", 10_000],
    ["1.2万", 12_000],
    ["2.3w", 23_000],
    ["1.2w", 12_000],
    ["1.2W", 12_000],
  ])("解析 %s 为 %i", (input, expected) => {
    expect(parseInteractionCount(input)).toBe(expected);
  });

  it("从共4条评论和互动控件文本读取三项数据", () => {
    expect(
      resolveInteractionMetrics([
        { kindHint: "LIKE", valueText: "176", contextText: "点赞" },
        { kindHint: "FAVORITE", valueText: "94", contextText: "收藏" },
        {
          kindHint: "COMMENT",
          valueText: "共 4 条评论",
          contextText: "评论总数",
        },
      ]),
    ).toMatchObject({
      likeCount: 176,
      favoriteCount: 94,
      commentCount: 4,
      totalCount: 274,
      status: "SUCCESS",
    });
  });

  it("任一互动数缺失时标记为无法完整读取", () => {
    expect(
      resolveInteractionMetrics([
        { valueText: "点赞 5" },
        { valueText: "收藏 4" },
      ]),
    ).toMatchObject({
      likeCount: 5,
      favoriteCount: 4,
      commentCount: null,
      totalCount: null,
      status: "UNAVAILABLE",
    });
  });
});
