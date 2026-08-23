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
    ["7,361", 7_361],
    ["7，361", 7_361],
    ["7361", 7_361],
    ["1243", 1_243],
    ["3052", 3_052],
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

  it("只接受显式 CONFIRMED_ZERO，不把普通空文本或动作标签猜成 0", () => {
    expect(
      resolveInteractionMetrics([
        {
          kindHint: "LIKE",
          valueText: "1",
          source: "DOM_CURRENT_NOTE_ACTION_BAR:SEMANTIC_CLASS",
        },
        {
          kindHint: "FAVORITE",
          valueText: "收藏",
          source: "DOM_CURRENT_NOTE_ACTION_BAR:SEMANTIC_CLASS",
          evidenceStatus: "CONFIRMED_ZERO",
        },
        {
          kindHint: "COMMENT",
          valueText: "评论",
          source: "DOM_CURRENT_NOTE_ACTION_BAR:SEMANTIC_CLASS",
          evidenceStatus: "CONFIRMED_ZERO",
        },
      ]),
    ).toMatchObject({
      likeCount: 1,
      favoriteCount: 0,
      commentCount: 0,
      totalCount: 1,
      status: "SUCCESS",
      metricStatus: {
        LIKE: "VALUE",
        FAVORITE: "CONFIRMED_ZERO",
        COMMENT: "CONFIRMED_ZERO",
      },
    });

    expect(
      resolveInteractionMetrics([
        {
          kindHint: "LIKE",
          valueText: "1",
          source: "DOM_CURRENT_NOTE_ACTION_BAR:SEMANTIC_CLASS",
        },
        {
          kindHint: "FAVORITE",
          valueText: "收藏",
          source: "DOM_CURRENT_NOTE_ACTION_BAR:SEMANTIC_CLASS",
        },
        {
          kindHint: "COMMENT",
          valueText: "评论",
          source: "DOM_CURRENT_NOTE_ACTION_BAR:SEMANTIC_CLASS",
        },
      ]),
    ).toMatchObject({
      favoriteCount: null,
      commentCount: null,
      totalCount: null,
      status: "UNAVAILABLE",
    });
  });

  it("CONFIRMED_ZERO 与同控件冲突数值并存时标记 CONFLICT", () => {
    expect(
      resolveInteractionMetrics([
        {
          kindHint: "LIKE",
          valueText: "0",
          source: "DOM_CURRENT_NOTE_ACTION_BAR:SEMANTIC_CLASS",
        },
        {
          kindHint: "LIKE",
          valueText: "1",
          source: "DOM_CURRENT_NOTE_ACTION_BAR:SVG_ICON",
        },
        { kindHint: "FAVORITE", valueText: "0" },
        { kindHint: "COMMENT", valueText: "0" },
      ]),
    ).toMatchObject({
      totalCount: null,
      status: "UNAVAILABLE",
      conflictCode: "INTERACTION_COUNT_CONFLICT",
      metricStatus: {
        LIKE: "CONFLICT",
        FAVORITE: "CONFIRMED_ZERO",
        COMMENT: "CONFIRMED_ZERO",
      },
    });
  });

  it("当前作品评论控件与评论总数冲突时拒绝静默选值", () => {
    expect(
      resolveInteractionMetrics([
        {
          kindHint: "LIKE",
          valueText: "7361",
          source: "DOM_CURRENT_NOTE_ACTION_BAR:SVG_ICON",
        },
        {
          kindHint: "FAVORITE",
          valueText: "1243",
          source: "DOM_CURRENT_NOTE_ACTION_BAR:SVG_ICON",
        },
        {
          kindHint: "COMMENT",
          valueText: "3052",
          source: "DOM_CURRENT_NOTE_ACTION_BAR:SVG_ICON",
        },
        {
          kindHint: "COMMENT",
          valueText: "共 3051 条评论",
          source: "DOM_COMMENT_SUMMARY",
        },
      ]),
    ).toMatchObject({
      likeCount: 7_361,
      favoriteCount: 1_243,
      commentCount: 3_052,
      totalCount: null,
      status: "UNAVAILABLE",
      conflictCode: "INTERACTION_COUNT_CONFLICT",
      technicalMessage: expect.stringContaining("INTERACTION_COUNT_CONFLICT"),
    });
  });
});
