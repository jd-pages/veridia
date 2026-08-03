import { describe, expect, it } from "vitest";
import {
  buildResultRiskWhere,
  parseResultRiskType,
  resultRiskLabels,
} from "@/lib/result-risk";

describe("审核结果风险筛选", () => {
  it("只接受三个业务风险类型并返回中文标签", () => {
    expect(parseResultRiskType("NOTE_UNAVAILABLE")).toBe("NOTE_UNAVAILABLE");
    expect(parseResultRiskType("TOPIC_MISSING")).toBe("TOPIC_MISSING");
    expect(parseResultRiskType("IMAGE_INSUFFICIENT")).toBe(
      "IMAGE_INSUFFICIENT",
    );
    expect(parseResultRiskType("READ_FAILED")).toBeUndefined();
    expect(Object.values(resultRiskLabels)).toEqual([
      "笔记不存在",
      "话题缺失",
      "图片不足",
    ]);
  });

  it("笔记不存在覆盖页面状态、失败码和错误页文案", () => {
    const serialized = JSON.stringify(
      buildResultRiskWhere("NOTE_UNAVAILABLE"),
    );
    for (const expected of [
      "PAGE_NOT_FOUND",
      "NOTE_DELETED",
      "PAGE_UNAVAILABLE",
      "ERROR_PAGE",
      "NOT_ACCESSIBLE",
      "你访问的页面不见了",
      "笔记不存在",
      "笔记已删除",
      "页面不存在",
    ]) {
      expect(serialized).toContain(expected);
    }
  });

  it("话题和图片风险都只统计页面正常的笔记", () => {
    const topic = buildResultRiskWhere("TOPIC_MISSING");
    const image = buildResultRiskWhere("IMAGE_INSUFFICIENT");
    const topicAnd = JSON.parse(JSON.stringify(topic)).AND as Array<{
      NOT?: unknown;
    }>;
    const imageAnd = JSON.parse(JSON.stringify(image)).AND as Array<{
      NOT?: unknown;
    }>;
    expect(topicAnd[0]).toEqual({ pageStatus: "NORMAL" });
    expect(imageAnd[0]).toEqual({ pageStatus: "NORMAL" });
    expect(JSON.stringify(topic)).toMatch(
      /missingTopics|缺少精准话题|未识别到话题|阶段话题未命中/u,
    );
    expect(JSON.stringify(image)).toMatch(
      /NON_COMPLIANT|IMAGES_READ_FAILED|图片数量不足/u,
    );
  });
});
